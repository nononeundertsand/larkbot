// 飞书机器人自动回复 —— 主程序
//
// 工作原理（无需公网服务器，走 lark-cli 自带 WebSocket 长连接）：
//   lark-cli event consume im.message.receive_v1   →  逐行 NDJSON 消息流
//        →  本脚本解析 / 去重 / 过滤自身消息
//        →  私聊：直接问答；群聊：仅当 @机器人 时响应
//              · @后判断意图：想总结 → 拉最近群聊记录做总结；否则普通问答
//        →  lark-cli im +messages-reply 回帖到原消息
//
// 退出：Ctrl+C（SIGINT）优雅停止。event 子进程异常退出会自动重连。

import './bootstrap-env.mjs'; // 必须最先执行：在其它模块读 env 前加载 .env（正确处理带引号的 JSON 值）
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { runAgent } from './agent.mjs';
import { assessSafety, llmConfigured } from './reply.mjs';
import {
  createGroupActivity,
  groupAutonomyConfig,
  noteGroupBotMessage,
  noteGroupMessage,
  shouldAutoParticipate,
  shouldSendIdleMessage,
} from './group-autonomy.mjs';
import {
  sessionKey,
  buildContext,
  buildGroupContext,
  appendTurn,
  appendGroupTurn,
  maintainMemory,
  maintainGroupMemory,
  flushMemory,
} from './memory.mjs';
import { getToolSchemas, getToolMetadata, executeTool, getRecentChatContext, renderMessageContent, resolveVisibleMentionsInContent } from './tools.mjs';
import { runLark } from './lark.mjs';
import { ApprovalStore } from './approval.mjs';
import { buildApprovalCard, buildApprovalStatusCard, parseApprovalActionValue } from './approval-card.mjs';
import { SessionQueue } from './session-queue.mjs';
import { RuntimeStateStore } from './state-store.mjs';
import { formatLarkFailureForUser, formatLarkSuccessForUser } from './lark-errors.mjs';
import { getOwnerName, getOwnerOpenId, initOwnerIdentity, isOwnerSender, maskId } from './owner.mjs';
import { containsLarkAtTag, larkAtTag, postContentFromTextWithMentions } from './lark-format.mjs';
import { splitReplyText } from './reply-parts.mjs';
import { formatSafetyRefusal } from './safety-response.mjs';
import {
  executeApprovedSandboxShellAction,
  executeApprovedShellAction,
  formatSandboxShellResultForUser,
  formatShellResultForUser,
  reviewSandboxCommandRequest,
  sandboxShellApprovalPreview,
  shellDockerEnabled,
  shellEnabled,
} from './shell.mjs';

const LARK_CLI = process.env.LARK_CLI_BIN || 'lark-cli';
const EVENT_KEY = 'im.message.receive_v1';
const CARD_ACTION_EVENT_KEY = 'card.action.trigger';
const IDENTITY = process.env.LARK_IDENTITY || 'bot'; // 回复身份：bot | user
const RECONNECT_DELAY_MS = 3000;
const APPROVAL_CARD_ENABLED = (process.env.APPROVAL_CARD_ENABLED || 'on').toLowerCase() !== 'off';
const MULTI_REPLY_ENABLED = (process.env.MULTI_REPLY_ENABLED || 'on').toLowerCase() !== 'off';
const MULTI_REPLY_MAX_PARTS = Number(process.env.MULTI_REPLY_MAX_PARTS || 3);
// 机器人主人（专属服务对象）的 open_id：其消息完全信任；其他人的请求要过安全评估。
let OWNER_OPEN_ID = getOwnerOpenId();
let OWNER_NAME = getOwnerName();
function refreshOwnerIdentity() {
  OWNER_OPEN_ID = getOwnerOpenId();
  OWNER_NAME = getOwnerName();
}
// 限流防刷：单个发送者在滑动窗口内的最大请求数 + 全局并发上限。主人不受限。
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000); // 窗口 60s
const RATE_MAX_PER_SENDER = Number(process.env.RATE_MAX_PER_SENDER || 5); // 每人每窗口 5 次
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3); // 全局同时处理上限
const LOG_CONTENT = (process.env.LOG_CONTENT || 'off').toLowerCase() === 'on';
const GROUP_CONTEXT_PREFETCH = (process.env.GROUP_CONTEXT_PREFETCH || 'smart').toLowerCase(); // smart | on | off
const GROUP_CONTEXT_LIMIT = Number(process.env.GROUP_CONTEXT_LIMIT || 15);
const GROUP_CONTEXT_INCLUDE_IMAGES = (process.env.GROUP_CONTEXT_INCLUDE_IMAGES || 'on').toLowerCase() !== 'off';
const CURRENT_MESSAGE_IMAGE_LIMIT = Number(process.env.CURRENT_MESSAGE_IMAGE_LIMIT || 3);
const GROUP_AUTONOMY = groupAutonomyConfig(process.env);
const GROUP_IDLE_PROMPT = process.env.GROUP_IDLE_PROMPT || '群里安静一会儿了，我出来冒个泡：大家现在有什么需要我帮忙整理、查资料或者跑腿的吗？';
const groupActivities = new Map();
let idleSweepTimer = null;

function groupActivity(chatId) {
  const key = String(chatId || '');
  if (!key) return createGroupActivity();
  const activity = groupActivities.get(key) || createGroupActivity();
  groupActivities.set(key, activity);
  return activity;
}

function setGroupActivity(chatId, activity) {
  const key = String(chatId || '');
  if (!key) return activity;
  groupActivities.set(key, activity);
  return activity;
}

function contentPreview(text) {
  const value = String(text || '');
  return LOG_CONTENT ? value.replace(/\s+/g, ' ').slice(0, 60) : `[${value.length} chars]`;
}

const GROUP_CONTEXT_HINT_RE = /(这|那|刚才|上面|前面|前文|他们|她们|他说|她说|大家|怎么看|对吗|啥意思|什么情况|总结|梳理|继续|接着|评评理|争|讨论|聊)/i;
function shouldPrefetchGroupContext(text) {
  if (GROUP_CONTEXT_PREFETCH === 'off') return false;
  if (GROUP_CONTEXT_PREFETCH === 'on') return true;
  const clean = String(text || '').trim();
  if (!clean) return true;
  return clean.length <= 40 || GROUP_CONTEXT_HINT_RE.test(clean);
}

async function renderCurrentMessageText(messageId, text, { includeImages = true } = {}) {
  if (!includeImages) return String(text || '').replace(/\s+/g, ' ').trim();
  return renderMessageContent(
    { message_id: messageId, content: text },
    { remaining: Math.max(0, Math.min(10, Number(CURRENT_MESSAGE_IMAGE_LIMIT) || 3)) },
  );
}

// 机器人自身标识：用于判断「群里 @ 的是不是我」。
// 实测：不同接口给的 mentions[].id 格式不同——
//   · event consume 事件流：id 是 open_id（ou_xxx）
//   · +messages-mget 接口：id 是 app_id（cli_xxx）
// 为稳妥，app_id / open_id / 机器人名字 三者任一命中都算「@我」。
// 换机器人时，改 .env 的 LARK_APP_ID / BOT_OPEN_ID / BOT_NAME 即可覆盖。
let BOT_APP_ID = process.env.LARK_APP_ID || '';
let BOT_OPEN_ID = process.env.BOT_OPEN_ID || '';
let BOT_NAME = process.env.BOT_NAME || '';

// 去重：飞书事件可能重复投递，用 message_id 作幂等键
const SEEN_MAX = 5000;
const EVENT_STATE_TTL_MS = Number(process.env.EVENT_STATE_TTL_MS || 7 * 24 * 3600 * 1000);
const stateStore = new RuntimeStateStore({
  maxProcessedEvents: SEEN_MAX,
  processedEventTtlMs: EVENT_STATE_TTL_MS,
});
const seen = new Set(stateStore.listProcessedEventIds());
function alreadyHandled(id, meta = {}) {
  if (!id) return false;
  if (seen.has(id)) return true;
  if (stateStore.rememberProcessedEvent(id, meta)) {
    seen.add(id);
    return true;
  }
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value); // 简单容量控制
  return false;
}
function forgetHandled(id) {
  if (!id) return;
  seen.delete(id);
  stateStore.forgetProcessedEvent(id);
}

// 时间闸：只处理「服务启动之后」发生的消息，忽略启动前的历史/积压事件。
// 背景：飞书对离线期间的消息有补推机制，且断线重连时可能重放一段历史事件；
// 而去重 seen 集合是内存态、重启即清空——两者叠加导致「重启后回复一堆旧消息」。
// STALE_GRACE_MS 给一点点宽限，避免把「启动瞬间刚发的消息」误杀。设 IGNORE_BACKLOG=off 可关闭本闸。
const START_TIME_MS = Date.now();
const STALE_GRACE_MS = Number(process.env.STALE_GRACE_MS || 15000); // 启动前 15s 内仍算「新」
const IGNORE_BACKLOG = (process.env.IGNORE_BACKLOG || 'on').toLowerCase() !== 'off';
// 从事件里尽力取「消息发生时间(ms)」。兼容三种形态：扁平(compact) d.create_time/d.timestamp、
// header.create_time、event.message.create_time。取不到返回 0（0 表示未知，不拦截）。
function getEventTimeMs(evt, d) {
  const cand = d.create_time || d.timestamp
    || evt?.header?.create_time
    || evt?.event?.message?.create_time
    || evt?.event?.message?.update_time
    || 0;
  const n = Number(cand);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 限流：按 sender 的滑动窗口计数。超限返回 true（应拒绝）。
const rateMap = new Map(); // senderId -> number[]（最近若干次请求的时间戳）
function isRateLimited(senderId) {
  if (!senderId) return false;
  const now = Date.now();
  const arr = (rateMap.get(senderId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_PER_SENDER) {
    rateMap.set(senderId, arr); // 保留窗口内记录
    return true;
  }
  arr.push(now);
  rateMap.set(senderId, arr);
  if (rateMap.size > 2000) rateMap.delete(rateMap.keys().next().value); // 容量控制
  return false;
}

const EVENT_QUEUE_MAX = Number(process.env.EVENT_QUEUE_MAX || 100);

const CONFIRM_TTL_MS = Number(process.env.CONFIRM_TTL_MS || 5 * 60 * 1000); // 5 分钟
const approvals = new ApprovalStore({ ttlMs: CONFIRM_TTL_MS, stateStore });

// 访客身份解析：用 open_id 查姓名+部门等（用主人的 user 身份查）。带缓存，避免重复请求。
// 解析开关：SET RESOLVE_VISITOR=off 可关闭。
const profileCache = new Map(); // openId -> { name, department, email, at }
const PROFILE_TTL_MS = Number(process.env.PROFILE_TTL_MS || 6 * 3600 * 1000); // 6h
async function resolveSenderProfile(openId) {
  if (!openId || (process.env.RESOLVE_VISITOR || '').toLowerCase() === 'off') return null;
  const cached = profileCache.get(openId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached;
  const r = await runLark(['contact', '+search-user', '--user-ids', openId, '--as', 'user']);
  const u = r.json?.data?.users?.[0];
  if (!u) return cached || null;
  const profile = {
    name: u.localized_name || u.name || '',
    department: u.department || '',
    email: u.enterprise_email || u.email || '',
    at: Date.now(),
  };
  profileCache.set(openId, profile);
  if (profileCache.size > 2000) profileCache.delete(profileCache.keys().next().value);
  return profile;
}

// 启动时自动发现机器人自己的标识：app_id（用于匹配 @）和 open_id。
async function discoverBotIdentity() {
  // 1) app_id：优先环境变量，否则从 config show 读取（这是群里 @机器人 时 mentions 里的值）
  if (!BOT_APP_ID) {
    const cfg = await runLark(['config', 'show']); // 注意：config show 不支持 --jq
    const appId = cfg.json?.appId;
    if (typeof appId === 'string' && appId.startsWith('cli_')) BOT_APP_ID = appId;
  }
  // 2) open_id + 机器人名字：优先环境变量，否则遍历机器人所在群的 bot 成员匹配 app_id
  if (!BOT_OPEN_ID || !BOT_NAME) {
    const chats = await runLark(['im', '+chat-list', '--as', 'bot', '--jq', '.data.chats[]?.chat_id']);
    const chatIds = (chats.out || '').split('\n').map((s) => s.trim().replace(/^"|"$/g, '')).filter((s) => s.startsWith('oc_'));
    for (const chatId of chatIds) {
      const r = await runLark(['im', '+chat-members-list', '--chat-id', chatId, '--member-types', 'bot', '--as', 'bot']);
      const bots = r.json?.data?.bots || [];
      const mine = bots.find((b) => BOT_APP_ID && b.app_id === BOT_APP_ID) || (bots.length === 1 ? bots[0] : null);
      if (mine?.member_id) {
        if (!BOT_OPEN_ID) BOT_OPEN_ID = mine.member_id;
        if (!BOT_NAME) BOT_NAME = mine.name || null;
        break;
      }
    }
  }
  console.log(`[bot] 机器人标识：app_id=${BOT_APP_ID || '未知'} open_id=${BOT_OPEN_ID || '未知'} name=${BOT_NAME || '未知'}`);
  if (!BOT_APP_ID && !BOT_OPEN_ID && !BOT_NAME) {
    console.warn('[bot] ⚠️ 未能确定机器人标识：群聊 @ 判断将退化为「只要有@就响应」。可在 .env 设 LARK_APP_ID / BOT_OPEN_ID / BOT_NAME。');
  }
}

// 判断这条群聊消息是否 @ 了机器人。
// 实测不同接口 mentions[].id 格式不同（事件流=open_id，mget=app_id），
// 且飞书有时根本不下发 mentions 数组，只在 content 文本里保留「@机器人名」。
// 因此按三层判断，任一命中都算「@我」：
//   1) mentions[].id 命中 app_id / open_id
//   2) mentions[].name 命中机器人名字
//   3) 兜底：content 文本里出现「@机器人名」
function isBotMentioned(d) {
  const mentions = d.mentions || [];
  // 1) + 2) 结构化匹配
  if (mentions.some((m) => m.id === BOT_APP_ID || m.id === BOT_OPEN_ID || (BOT_NAME && m.name === BOT_NAME))) {
    return true;
  }
  // 3) 文本兜底：content 里含「@机器人名」。用「去空格」比对，兼容全角/半角/不间断空格等差异。
  const content = String(d.content || '');
  if (BOT_NAME) {
    if (content.includes('@' + BOT_NAME)) return true;
    const squash = (s) => s.replace(/[\s\u00A0\u3000]/g, '');
    if (content.includes('@') && squash(content).includes('@' + squash(BOT_NAME))) return true;
  }
  // 完全拿不到任何标识时，保守认为「有 mentions 就算 @我」
  if (!BOT_APP_ID && !BOT_OPEN_ID && !BOT_NAME && mentions.length > 0) return true;
  return false;
}

function eventSenderName(d = {}) {
  return String(d.sender?.name || d.sender_name || d.operator_name || '').trim();
}

function eventSenderBotMention(d = {}) {
  const id = String(
    d.sender_id ||
    d.sender?.id ||
    d.sender?.sender_id ||
    d.sender?.open_id ||
    d.sender?.app_id ||
    '',
  ).trim();
  const name = eventSenderName(d) || '对方机器人';
  return id ? larkAtTag(id, name) : name;
}

function isSelfBotSender(d = {}) {
  const ids = [
    d.sender_id,
    d.sender?.id,
    d.sender?.sender_id,
    d.sender?.open_id,
    d.sender?.app_id,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  if (ids.some((id) => id === BOT_OPEN_ID || id === BOT_APP_ID)) return true;
  const name = eventSenderName(d);
  return Boolean(!ids.length && BOT_NAME && name && name === BOT_NAME);
}

// 去掉文本里的 @机器人 占位/名字，得到用户真正说的话
function stripMention(text, mentions) {
  let t = text || '';
  for (const m of mentions || []) {
    if (m.key) t = t.split(m.key).join(''); // 去掉 @_user_1 之类占位
    if (m.name) t = t.split('@' + m.name).join('').split(m.name).join('');
  }
  // 兜底：mentions 为空但文本里有「@机器人名」时也去掉
  if (BOT_NAME) t = t.split('@' + BOT_NAME).join('');
  return t.replace(/\s+/g, ' ').trim();
}

// 调 lark-cli 回帖。用数组传参（非 shell 字符串），彻底避免转义/注入问题。
async function replyMessage(messageId, text) {
  const args = containsLarkAtTag(text)
    ? [
      'im', '+messages-reply',
      '--message-id', messageId,
      '--msg-type', 'post',
      '--content', JSON.stringify(postContentFromTextWithMentions(text)),
      '--as', IDENTITY,
    ]
    : [
      'im', '+messages-reply',
      '--message-id', messageId,
      '--markdown', text,
      '--as', IDENTITY,
    ];
  const r = await runLark(args);
  const ok = r.code === 0 && (r.json ? r.json.ok !== false : true);
  if (ok) console.log(`[reply] ✅ 已回复 ${messageId}`);
  else console.error(`[reply] ❌ 回复失败 ${messageId} (code=${r.code}): ${r.err.trim() || r.out.trim()}`);
  return ok;
}

async function sendGroupMessage(chatId, text) {
  const args = containsLarkAtTag(text)
    ? [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'post',
      '--content', JSON.stringify(postContentFromTextWithMentions(text)),
      '--as', 'bot',
    ]
    : [
      'im', '+messages-send',
      '--chat-id', chatId,
      '--markdown', text,
      '--as', 'bot',
    ];
  const r = await runLark(args);
  const ok = r.code === 0 && (r.json ? r.json.ok !== false : true);
  if (ok) console.log(`[send] ✅ 已主动发群消息 ${chatId}`);
  else console.error(`[send] ❌ 主动发群消息失败 ${chatId} (code=${r.code}): ${r.err.trim() || r.out.trim()}`);
  return ok;
}

async function replyApprovalCard(messageId, action) {
  if (!APPROVAL_CARD_ENABLED || !messageId || !action) return false;
  const card = buildApprovalCard(action, { ttlMs: CONFIRM_TTL_MS });
  const r = await runLark([
    'im', '+messages-reply',
    '--message-id', messageId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    '--as', 'bot',
  ]);
  const ok = r.code === 0 && (r.json ? r.json.ok !== false : true);
  if (ok) console.log(`[reply] ✅ 已回复确认卡片 ${messageId}`);
  else console.error(`[reply] ❌ 确认卡片发送失败 ${messageId} (code=${r.code}): ${r.err.trim() || r.out.trim()}`);
  return ok;
}

async function updateApprovalCard(token, action, { status, detail }) {
  if (!token) return false;
  const card = buildApprovalStatusCard(action || {}, { status, detail });
  const r = await runLark([
    'api', 'POST', '/open-apis/interactive/v1/card/update',
    '--as', 'bot',
    '--data', JSON.stringify({ token, card }),
  ]);
  const ok = r.code === 0 && (r.json ? r.json.ok !== false : true);
  if (!ok) console.error(`[card] ❌ 更新确认卡片失败 (code=${r.code}): ${r.err.trim() || r.out.trim()}`);
  return ok;
}

async function executePendingApproval(pending) {
  console.log(`[confirm] 执行 action=${pending.id?.slice(0, 8) || 'legacy'} tool=${pending.toolName || 'unknown'}`);
  if (pending.executor === 'shell') {
    const r = await executeApprovedShellAction(pending.shell);
    return formatShellResultForUser(pending, r);
  }
  if (pending.executor === 'sandbox_shell') {
    const r = await executeApprovedSandboxShellAction(pending.shell);
    return formatSandboxShellResultForUser(pending, r);
  }
  const r = await runLark(pending.args);
  if (r.code !== 0 || r.json?.ok === false) return formatLarkFailureForUser(r);
  return formatLarkSuccessForUser(pending, r);
}

async function replyAgentResponse(messageId, response, { chatId = '' } = {}) {
  const rawText = typeof response === 'string' ? response : String(response?.text || '');
  const text = chatId ? await resolveVisibleMentionsInContent(rawText, { chatId }) : rawText;
  if (response?.approvalAction) {
    const cardSent = await replyApprovalCard(messageId, response.approvalAction);
    if (cardSent) return true;
  }
  const parts = splitReplyText(text, {
    enabled: MULTI_REPLY_ENABLED,
    maxParts: MULTI_REPLY_MAX_PARTS,
  });
  let ok = true;
  for (const part of parts) {
    ok = await replyMessage(messageId, part) && ok;
  }
  return ok;
}

function prefixResponseMention(response, mention = '') {
  const prefix = String(mention || '').trim();
  if (!prefix) return response;
  const raw = typeof response === 'string' ? response : String(response?.text || '');
  if (!raw.trim() || raw.trim().startsWith(prefix)) return response;
  const text = `${prefix} ${raw}`.trim();
  return typeof response === 'string' ? text : { ...response, text };
}

function ownerAtText() {
  return OWNER_OPEN_ID ? larkAtTag(OWNER_OPEN_ID, OWNER_NAME) : OWNER_NAME;
}

function ownerPlainText() {
  return OWNER_NAME;
}

function confirmationMessage(preview, token) {
  return `${String(preview || '').trim()}\n确认码：${token}\n请回复「确认 ${token}」执行，或「取消」放弃。`;
}

async function commandSearchNote(review) {
  if (review.sandboxMode === 'apt_install') return '';
  const known = new Set(['ls', 'pwd', 'cat', 'find', 'grep', 'rg', 'git', 'npm', 'python', 'python3', 'curl', 'wget', 'neofetch']);
  const command = String(review.command || '').toLowerCase();
  if (!command || known.has(command)) return '';
  try {
    const result = await executeTool('web_search', { query: `${command} linux command`, limit: 2 }, { isOwner: false });
    const rows = Array.isArray(result?.results) ? result.results.slice(0, 2) : [];
    if (!rows.length) return '';
    return [
      '联网检索：',
      ...rows.map((item) => `- ${item.title || item.url || '搜索结果'}：${String(item.snippet || item.summary || '').replace(/\s+/g, ' ').slice(0, 160)}`),
    ].join('\n');
  } catch (err) {
    console.warn(`[command] 命令说明联网检索失败：${err.message}`);
    return '';
  }
}

async function handleVisitorSandboxCommandRequest(messageId, text, {
  chatId,
  senderName,
  senderDept = '',
  confirmationKey,
} = {}) {
  const review = reviewSandboxCommandRequest({
    text,
    purpose: `访客 ${senderName || '其他用户'} 在群聊请求执行命令`,
  });
  if (!review.ok && review.kind === 'none') return false;

  if (!review.ok) {
    const sent = await replyMessage(messageId, [
      '我识别到这是一条命令类请求，但不会进入执行确认。',
      '',
      `原始内容：\`${String(review.rawCommand || text).replace(/`/g, '\\`')}\``,
      `原因：${review.reason}`,
      '处理结果：不执行，也不发起确认卡片。请改成单个结构化命令，避免管道、重定向、多命令连接符或交互式 shell。',
    ].join('\n'));
    if (!sent) forgetHandled(messageId);
    return true;
  }
  if (!confirmationKey) {
    const sent = await replyMessage(messageId, '我识别到这是一条命令类请求，但当前没有可用的主人确认会话。请先配置 OWNER_OPEN_ID 后再发起。');
    if (!sent) forgetHandled(messageId);
    return true;
  }

  const requester = `${senderName || '其他用户'}${senderDept ? ` / ${senderDept}` : ''}`;
  const preview = sandboxShellApprovalPreview(review, { requester, ownerAt: ownerPlainText() });
  const confirmToken = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const action = {
    id: randomUUID(),
    toolName: 'visitor_sandbox_command',
    executor: 'sandbox_shell',
    shell: review.action,
    preview: confirmationMessage(preview, confirmToken),
    confirmToken,
    createdAt: Date.now(),
    confirmationKey,
  };
  const registered = approvals.register(confirmationKey, action);
  const lookupNote = await commandSearchNote(review);
  const analysis = [
    `已识别为命令执行请求：\`${String(review.rawCommand || review.displayCommand).replace(/`/g, '\\`')}\``,
    '',
    `功能：${review.sandboxMode === 'apt_install' ? `安装软件包 ${review.packages.join('、')}` : review.displayCommand}`,
    lookupNote,
    `风险：${review.risk}。${review.reason}`,
    `沙箱：Docker，workspace=none，network=${review.network || 'none'}，rootfs=${review.readOnlyRootfs === false ? '临时可写' : '只读'}。`,
    `${ownerAtText()} 我已生成确认卡片；你确认后才会在沙箱里执行。`,
  ].join('\n');
  const sent = await replyMessage(messageId, analysis);
  if (!sent) {
    forgetHandled(messageId);
    return true;
  }
  const cardSent = await replyApprovalCard(messageId, registered);
  if (!cardSent) await replyMessage(messageId, registered.preview);
  console.log(`[command] visitor sandbox approval action=${registered.id.slice(0, 8)} chat=${chatId || ''}`);
  return true;
}

// 统一的「问答（含写操作二次确认）」处理：
//  - 主人若回复「确认 <确认码>」且有待执行的写命令 → 执行它
//  - 主人若回复「取消」→ 放弃
//  - 否则正常跑 Agent；Agent 内的写操作会先登记 pending 并提示，等下一条「确认」
async function runAgentWithConfirm(text, ctx, confirmationKey, isOwner) {
  const decision = approvals.resolve(confirmationKey, text, { isOwner });
  if (decision.kind === 'execute') {
    return { text: await executePendingApproval(decision.action) };
  }
  if (decision.kind === 'cancel') {
    return { text: '好的，已取消该操作。' };
  }
  if (decision.kind === 'expired') {
    return { text: '这条待确认操作已经过期，未执行。请重新发起操作。' };
  }
  if (decision.kind === 'mismatch') {
    const token = decision.action?.confirmToken;
    return { text: token
      ? `确认码不匹配，未执行。请回复「确认 ${token}」执行，或「取消」放弃。`
      : '确认内容不匹配，未执行。' };
  }

  // 正常 Agent 处理；注入 registerPendingWrite 让写操作可登记待确认
  let registeredAction = null;
  const agentCtx = {
    ...ctx,
    confirmedWrite: false,
      registerPendingWrite: (action) => {
        registeredAction = approvals.register(action?.confirmationKey || confirmationKey, action);
      },
  };
  const answer = await runAgent(text, agentCtx, { getToolSchemas, getToolMetadata, executeTool });
  return {
    text: answer,
    approvalAction: registeredAction && answer === registeredAction.preview ? registeredAction : null,
  };
}

async function runGroupAgentForMessage({ text, chatId, messageId, senderId, senderName, senderProfile, isOwner, threadContext = '' }) {
  const gKey = sessionKey({
    chatType: 'group',
    chatId,
    senderId,
    senderName,
    senderDept: senderProfile?.department || '',
    senderEmail: senderProfile?.email || '',
  });
  const gCtx = buildContext(gKey, { persist: true, query: text });
  const sharedGroupCtx = buildGroupContext(chatId, { persist: true, query: text });
  const response = await runAgentWithConfirm(text, {
    isOwner,
    senderId,
    senderName,
    senderDept: senderProfile?.department || '',
    chatId,
    messageId,
    ownerConfirmationKey: OWNER_OPEN_ID ? `g:${chatId}:${OWNER_OPEN_ID}` : '',
    ...gCtx,
    ...sharedGroupCtx,
    threadContext,
  }, gKey.id, isOwner);
  return { response, gKey };
}

// 处理单条消息事件
async function handleEvent(evt) {
  // event consume 输出形如 { ok, event_key, data: {...实际字段...} }，兼容直接是字段的情况
  const d = evt.data || evt;
  const messageId = d.message_id || d.id;
  if (!messageId) return;
  if (alreadyHandled(messageId, {
    chatId: d.chat_id || '',
    senderId: d.sender_id || '',
    eventTime: getEventTimeMs(evt, d),
  })) return;

  // 时间闸：忽略「服务启动之前」发生的历史/积压消息（飞书离线补推 + 断线重连重放）。
  // 只有能明确判定为「旧」的才拦（取到时间且早于启动时刻-宽限）；取不到时间则放行，避免误杀。
  if (IGNORE_BACKLOG) {
    const evtMs = getEventTimeMs(evt, d);
    if (evtMs > 0 && evtMs < START_TIME_MS - STALE_GRACE_MS) {
      const ageSec = Math.round((START_TIME_MS - evtMs) / 1000);
      console.log(`[skip] 忽略启动前的历史消息 ${messageId}（早于启动 ${ageSec}s）`);
      return;
    }
  }

  const chatType = d.chat_type || 'p2p';
  const rawText = d.content ?? '';
  const preview = contentPreview(rawText);
  const senderType = d.sender_type || '';
  const isBotSender = senderType === 'bot';
  if (isBotSender && isSelfBotSender(d)) {
    console.log(`[skip] 来自当前机器人的消息，忽略 ${messageId}`);
    return;
  }
  if (isBotSender && chatType !== 'group') {
    console.log(`[skip] 来自其它机器人的非群聊消息，忽略 ${messageId}`);
    return;
  }

  // 识别来访者身份：是不是主人本人（真实姓名/部门延后到确认要响应时再解析，省请求）
  const senderId = d.sender_id || '';
  const isOwner = isOwnerSender(senderId);
  let senderName = isOwner ? OWNER_NAME : (isBotSender ? (eventSenderName(d) || '其他机器人') : '其他用户');
  let senderProfile = null;
  // 解析访客身份（姓名+部门），带缓存；填充 senderName / senderProfile
  const resolveVisitor = async () => {
    if (isOwner || isBotSender) return;
    senderProfile = await resolveSenderProfile(senderId);
    if (senderProfile?.name) senderName = senderProfile.name;
  };
  const whoLabel = () => isOwner
    ? '主人'
    : `${isBotSender ? '机器人' : '访客'}(${senderName}${senderProfile?.department ? ' / ' + senderProfile.department : ''})`;

  // 群聊：默认仅 @ 机器人时响应；开启 GROUP_AUTO_PARTICIPATE 后可按策略自动参与。
  if (chatType === 'group') {
    const mentioned = isBotMentioned(d);
    let activity = setGroupActivity(d.chat_id, noteGroupMessage(groupActivity(d.chat_id), getEventTimeMs(evt, d) || Date.now()));
    const userText = mentioned ? stripMention(rawText, d.mentions) : rawText;
    let renderedUserText = await renderCurrentMessageText(messageId, userText, {
      includeImages: GROUP_CONTEXT_INCLUDE_IMAGES,
    });
    if (!mentioned) {
      const decision = shouldAutoParticipate({
        text: renderedUserText,
        mentioned,
        isBotSender,
        activity,
        config: GROUP_AUTONOMY,
      });
      if (!decision.ok) {
        const men = (d.mentions || []).map((m) => `${m.name}(${m.id})`).join(', ') || '无';
        console.log(`[skip] 群聊未@我，忽略 ${messageId} reason=${decision.reason} <- "${preview}" | mentions=[${men}]`);
        return;
      }
      renderedUserText = `（系统提示：这是群聊自动参与，不是用户直接 @ 你。请自然接一句，保持简短，不要喧宾夺主。）\n${renderedUserText}`;
    }

    // 限流：访客受滑动窗口限制，主人不受限（限流在身份解析之前，省下被限流者的解析请求）
    if (!isOwner && isRateLimited(senderId)) {
      console.warn(`[rate] ⚠️ 访客 ${senderId} 触发限流，忽略 ${messageId}`);
      return;
    }
    await resolveVisitor(); // 解析访客姓名+部门
    console.log(`[recv] ${mentioned ? 'group@' : 'group-auto'} ${whoLabel()} sender=${maskId(senderId)} msg=${messageId} <- ${contentPreview(renderedUserText)}`);

    if (!isOwner && !isBotSender) {
      const handledCommand = await handleVisitorSandboxCommandRequest(messageId, renderedUserText, {
        chatId: d.chat_id,
        senderName,
        senderDept: senderProfile?.department || '',
        confirmationKey: OWNER_OPEN_ID ? `g:${d.chat_id}:${OWNER_OPEN_ID}` : '',
      });
      if (handledCommand) return;
    }

    // 安全闸（访客）：先挡明显的凭证索取 / 提示词注入等硬风险；
    // 更细的越权（查主人隐私等）由工具层的权限门禁精确控制。
    if (!isOwner) {
      const { risky, reason } = await assessSafety(renderedUserText);
      if (risky) {
        console.warn(`[safety] ⚠️ 拒绝访客请求 ${messageId}：${reason}`);
        const sent = await replyMessage(messageId, formatSafetyRefusal({ text: renderedUserText, reason, ownerName: OWNER_NAME }));
        if (!sent) forgetHandled(messageId);
        return;
      }
    }

    const qText = renderedUserText || '你好';
    let threadContext = '';
    if (shouldPrefetchGroupContext(qText)) {
      const recent = await getRecentChatContext(d.chat_id, {
        limit: GROUP_CONTEXT_LIMIT,
        messageId,
        includeImages: GROUP_CONTEXT_INCLUDE_IMAGES,
      });
      if (recent.error) console.warn(`[context] 群聊上下文预取失败 ${messageId}: ${recent.error}`);
      else threadContext = recent.text || '';
    }
    const { response, gKey } = await runGroupAgentForMessage({
      text: qText,
      chatId: d.chat_id,
      messageId,
      senderId,
      senderName,
      senderProfile,
      isOwner,
      threadContext,
    });
    const finalResponse = (isBotSender && mentioned)
      ? prefixResponseMention(response, eventSenderBotMention(d))
      : response;
    const answer = finalResponse.text;
    const sent = await replyAgentResponse(messageId, finalResponse, { chatId: d.chat_id });
    if (!sent) {
      forgetHandled(messageId);
      return;
    }
    activity = setGroupActivity(d.chat_id, noteGroupBotMessage(activity));
    appendTurn(gKey, qText, answer, { persist: true });
    appendGroupTurn(d.chat_id, { senderName, userText: qText, assistantText: answer, threadContext }, { persist: true });
    maintainMemory(gKey).catch((e) => console.error('[memory] 维护异常：', e.message)); // 异步，不阻塞
    maintainGroupMemory(d.chat_id).catch((e) => console.error('[memory] 群共享记忆维护异常：', e.message));
    return;
  }

  // 私聊：直接问答（同样区分主人/访客）
  // 限流：访客受滑动窗口限制，主人不受限（限流在身份解析之前）
  if (!isOwner && isRateLimited(senderId)) {
    console.warn(`[rate] ⚠️ 访客 ${senderId} 触发限流，忽略 ${messageId}`);
    return;
  }
  await resolveVisitor(); // 解析访客姓名+部门
  const renderedRawText = await renderCurrentMessageText(messageId, rawText, { includeImages: true });
  console.log(`[recv] p2p ${whoLabel()} sender=${maskId(senderId)} msg=${messageId} <- "${contentPreview(renderedRawText)}"`);

  // 安全闸（访客）：挡凭证索取/注入等硬风险；细粒度越权由工具权限门禁控制。
  if (!isOwner) {
    const { risky, reason } = await assessSafety(renderedRawText);
    if (risky) {
      console.warn(`[safety] ⚠️ 拒绝访客私聊请求 ${messageId}：${reason}`);
      const sent = await replyMessage(messageId, formatSafetyRefusal({ text: renderedRawText, reason, ownerName: OWNER_NAME }));
      if (!sent) forgetHandled(messageId);
      return;
    }
  }
  // 统一交给 Agent 编排（私聊无群上下文，查群成员/群消息类工具会提示不可用；查人等仍可用）
  const pKey = sessionKey({ chatType, chatId: d.chat_id, senderId, senderName, senderDept: senderProfile?.department || '', senderEmail: senderProfile?.email || '' });
  const pCtx = buildContext(pKey, { persist: true, query: renderedRawText }); // 主人与访客均持久化三层记忆
  const response = await runAgentWithConfirm(renderedRawText, {
      isOwner,
      senderId,
      senderName,
      senderDept: senderProfile?.department || '',
      chatId: '',
      ownerConfirmationKey: OWNER_OPEN_ID ? `p:${OWNER_OPEN_ID}` : '',
      ...pCtx,
  }, pKey.id, isOwner);
  const answer = response.text;
  const sent = await replyAgentResponse(messageId, response);
  if (!sent) {
    forgetHandled(messageId);
    return;
  }
  appendTurn(pKey, renderedRawText, answer, { persist: true });
  maintainMemory(pKey).catch((e) => console.error('[memory] 维护异常：', e.message)); // 异步，不阻塞
}

async function handleCardActionEvent(evt) {
  const d = evt.data || evt;
  const eventId = d.event_id || `${d.message_id || 'unknown'}:${d.operator_id || 'unknown'}:${d.timestamp || Date.now()}`;
  if (alreadyHandled(eventId, {
    chatId: d.chat_id || '',
    senderId: d.operator_id || '',
    eventTime: Number(d.timestamp) || 0,
  })) return;

  const payload = parseApprovalActionValue(d.action_value);
  if (!payload) return;

  if (!isOwnerSender(d.operator_id || '')) {
    console.warn(`[card] 非主人点击确认卡片 operator=${maskId(d.operator_id || '')}`);
    if (d.message_id) await replyMessage(d.message_id, '只有主人可以确认或取消该操作。');
    return;
  }

  const decision = approvals.resolveAction(payload.confirmationKey, payload, { isOwner: true });
  const action = decision.action || {};
  let status = 'invalid';
  let detail = '这条确认已经失效，请重新发起操作。';

  if (decision.kind === 'execute') {
    detail = await executePendingApproval(action);
    status = /^执行失败/.test(detail) ? 'failed' : 'success';
  } else if (decision.kind === 'cancel') {
    status = 'canceled';
    detail = '好的，已取消该操作。';
  } else if (decision.kind === 'expired') {
    status = 'expired';
    detail = '这条待确认操作已经过期，未执行。请重新发起操作。';
  } else if (decision.kind === 'mismatch') {
    status = 'invalid';
    detail = '确认内容不匹配，未执行。';
  }

  const updated = await updateApprovalCard(d.token, action, { status, detail });
  if (!updated && d.message_id) await replyMessage(d.message_id, detail);
}

function eventMessageId(evt) {
  const d = evt?.data || evt || {};
  return d.message_id || d.id || '';
}

function eventSessionKey(evt) {
  const d = evt?.data || evt || {};
  const senderId = d.sender_id || '';
  if (!senderId) return '';
  const chatType = d.chat_type || 'p2p';
  return chatType === 'group'
    ? `g:${d.chat_id || 'unknown'}:${senderId}`
    : `p:${senderId}`;
}

const eventScheduler = new SessionQueue({
  maxConcurrent: MAX_CONCURRENT,
  maxQueued: EVENT_QUEUE_MAX,
  getKey: eventSessionKey,
  onError: (e, evt) => {
    const id = eventMessageId(evt);
    if (id) forgetHandled(id);
    console.error('[handle] 未捕获异常：', e);
  },
});

function enqueueEvent(evt) {
  if (!eventScheduler.enqueue(evt, handleEvent)) {
    console.error(`[queue] 事件队列已满(${EVENT_QUEUE_MAX})，拒绝接收新事件`);
    return false;
  }
  return true;
}

function cardActionEventId(evt) {
  const d = evt?.data || evt || {};
  return d.event_id || `${d.message_id || 'unknown'}:${d.operator_id || 'unknown'}:${d.timestamp || ''}`;
}

function cardActionSessionKey(evt) {
  const d = evt?.data || evt || {};
  const payload = parseApprovalActionValue(d.action_value);
  return payload?.confirmationKey || d.operator_id || cardActionEventId(evt);
}

const cardActionScheduler = new SessionQueue({
  maxConcurrent: Math.max(1, Math.min(MAX_CONCURRENT, 3)),
  maxQueued: EVENT_QUEUE_MAX,
  getKey: cardActionSessionKey,
  onError: (e, evt) => {
    const id = cardActionEventId(evt);
    if (id) forgetHandled(id);
    console.error('[card] 未捕获异常：', e);
  },
});

function enqueueCardActionEvent(evt) {
  if (!cardActionScheduler.enqueue(evt, handleCardActionEvent)) {
    console.error(`[queue] 卡片事件队列已满(${EVENT_QUEUE_MAX})，拒绝接收新事件`);
    return false;
  }
  return true;
}

let consumerChild = null;
let consumerRl = null;
let reconnectTimer = null;
let cardConsumerChild = null;
let cardConsumerRl = null;
let cardReconnectTimer = null;
let shuttingDown = false;

function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer) return;
  console.error(`[bot] 事件流断开（${reason}），${RECONNECT_DELAY_MS / 1000}s 后重连…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startConsumer();
  }, RECONNECT_DELAY_MS);
}

function scheduleCardReconnect(reason) {
  if (shuttingDown || cardReconnectTimer || !APPROVAL_CARD_ENABLED) return;
  console.error(`[card] 事件流断开（${reason}），${RECONNECT_DELAY_MS / 1000}s 后重连…`);
  cardReconnectTimer = setTimeout(() => {
    cardReconnectTimer = null;
    startCardActionConsumer();
  }, RECONNECT_DELAY_MS);
}

async function handleIdleGroup(chatId, activity) {
  const decision = shouldSendIdleMessage({ activity, config: GROUP_AUTONOMY });
  if (!decision.ok) return;
  const text = GROUP_IDLE_PROMPT;
  const sent = await sendGroupMessage(chatId, text);
  if (sent) {
    setGroupActivity(chatId, noteGroupBotMessage(activity));
    appendGroupTurn(chatId, { senderName: BOT_NAME || 'bot', userText: '(idle)', assistantText: text, threadContext: '' }, { persist: true });
    maintainGroupMemory(chatId).catch((e) => console.error('[memory] 群共享记忆维护异常：', e.message));
  }
}

function startIdleSweep() {
  if (!GROUP_AUTONOMY.autoIdleMessage || idleSweepTimer || shuttingDown) return;
  idleSweepTimer = setInterval(() => {
    for (const [chatId, activity] of groupActivities.entries()) {
      handleIdleGroup(chatId, activity).catch((err) => console.error(`[idle] 主动群消息失败 ${chatId}:`, err.message));
    }
  }, GROUP_AUTONOMY.idleCheckMs);
  idleSweepTimer.unref?.();
}

// 启动一次 event consume，并把 stdout 按行喂给队列
function startConsumer() {
  if (shuttingDown || consumerChild) return;
  console.log(`[bot] 启动事件消费：${EVENT_KEY}（identity=${IDENTITY}）`);
  // 注意：event consume 把 stdin 的 EOF 当作退出信号（为 AI 子进程场景设计）。
  // 因此必须给它一个「保持打开」的 stdin 管道，且永不调用 .end()，否则子进程会秒退。
  const child = spawn(
    LARK_CLI,
    ['event', 'consume', EVENT_KEY, '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'inherit'] } // stdin 保持打开；stderr 直通便于看连接日志
  );
  consumerChild = child;
  if (child.stdin) child.stdin.on('error', () => {}); // 忽略管道关闭时的 EPIPE

  const rl = readline.createInterface({ input: child.stdout });
  consumerRl = rl;
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s || s[0] !== '{') return; // 跳过非 JSON 的提示行
    let evt;
    try { evt = JSON.parse(s); } catch { return; }
    enqueueEvent(evt);
  });

  let ended = false;
  const onEnded = (reason) => {
    if (ended) return;
    ended = true;
    if (consumerChild === child) consumerChild = null;
    if (consumerRl === rl) consumerRl = null;
    try { rl.close(); } catch { /* ignore */ }
    scheduleReconnect(reason);
  };
  child.on('close', (code) => onEnded(`code=${code}`));
  child.on('error', (e) => {
    console.error(`[bot] 无法启动 ${LARK_CLI}: ${e.message}`);
    onEnded(e.message);
  });
}

function startCardActionConsumer() {
  if (!APPROVAL_CARD_ENABLED || shuttingDown || cardConsumerChild) return;
  console.log(`[card] 启动事件消费：${CARD_ACTION_EVENT_KEY}（identity=bot）`);
  const child = spawn(
    LARK_CLI,
    ['event', 'consume', CARD_ACTION_EVENT_KEY, '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  cardConsumerChild = child;
  if (child.stdin) child.stdin.on('error', () => {});

  const rl = readline.createInterface({ input: child.stdout });
  cardConsumerRl = rl;
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s || s[0] !== '{') return;
    let evt;
    try { evt = JSON.parse(s); } catch { return; }
    enqueueCardActionEvent(evt);
  });

  let ended = false;
  const onEnded = (reason) => {
    if (ended) return;
    ended = true;
    if (cardConsumerChild === child) cardConsumerChild = null;
    if (cardConsumerRl === rl) cardConsumerRl = null;
    try { rl.close(); } catch { /* ignore */ }
    scheduleCardReconnect(reason);
  };
  child.on('close', (code) => onEnded(`code=${code}`));
  child.on('error', (e) => {
    console.error(`[card] 无法启动 ${LARK_CLI}: ${e.message}`);
    onEnded(e.message);
  });
}

function stopConsumer() {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (cardReconnectTimer) clearTimeout(cardReconnectTimer);
  if (idleSweepTimer) clearInterval(idleSweepTimer);
  reconnectTimer = null;
  cardReconnectTimer = null;
  idleSweepTimer = null;
  try { consumerRl?.close(); } catch { /* ignore */ }
  try { consumerChild?.kill('SIGTERM'); } catch { /* ignore */ }
  try { cardConsumerRl?.close(); } catch { /* ignore */ }
  try { cardConsumerChild?.kill('SIGTERM'); } catch { /* ignore */ }
  consumerRl = null;
  consumerChild = null;
  cardConsumerRl = null;
  cardConsumerChild = null;
  eventScheduler.clear();
  cardActionScheduler.clear();
}

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n[bot] 收到 ${signal}，正在优雅退出…`);
  stopConsumer();
  const deadline = Date.now() + 5000;
  while ((eventScheduler.inFlight > 0 || cardActionScheduler.inFlight > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await flushMemory();
  process.exit(0);
}

process.once('SIGINT', () => { shutdown('SIGINT'); });
process.once('SIGTERM', () => { shutdown('SIGTERM'); });

await initOwnerIdentity(runLark);
refreshOwnerIdentity();
console.log('================ 飞书机器人自动回复 ================');
console.log(`回复模式：${llmConfigured() ? '大模型问答 (' + (process.env.LLM_MODEL || 'default') + ')' : 'mock 回声（未配置 LLM）'}`);
console.log(`专属主人：${OWNER_NAME}（${maskId(OWNER_OPEN_ID)}）`);
if (!OWNER_OPEN_ID) console.warn('[bot] ⚠️ 未配置 OWNER_OPEN_ID，且自动发现失败：所有人都会按访客处理，主人专属工具不可用。请在 .env 中配置 OWNER_OPEN_ID，或确认 lark-cli user 登录态有效。');
console.log(`能力：Agent 工具编排（读最新版 lark-cli skills 文档自主调用 lark-cli：查人/群成员/消息/总结/日历/文档/任务…）`);
console.log(`受限 Shell：${shellEnabled() ? `已启用 / runner=${shellDockerEnabled() ? 'docker' : 'local'}` : '未启用'}（默认关闭，仅主人可用）`);
console.log(`群聊策略：${GROUP_AUTONOMY.autoParticipate ? '自动参与已开启' : '仅 @机器人 时响应'}${GROUP_AUTONOMY.autoIdleMessage ? `；空闲主动消息 ${Math.round(GROUP_AUTONOMY.idleMs / 60000)}min` : ''}${IGNORE_BACKLOG ? '；忽略启动前的历史/积压消息' : ''}`);
console.log(`安全策略：访客经安全评估(硬闸+防注入+fail-closed)；写操作仅主人且需卡片按钮或回复带确认码的「确认 ABC123」；限流 ${RATE_MAX_PER_SENDER}次/${RATE_WINDOW_MS / 1000}s/人，并发上限 ${MAX_CONCURRENT}`);
console.log(`对话记忆：短期滑动窗口(内存) + 长期摘要 + 关键JSON(按用户落盘 data/memory)；主人与访客均享完整三层`);
console.log('私聊：收到即回。Ctrl+C 退出。');
console.log('====================================================');
await discoverBotIdentity();
startConsumer();
startCardActionConsumer();
startIdleSweep();

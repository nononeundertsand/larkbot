// 工具注册表：把 lark-cli 的能力包装成 LLM 可调用的「工具」。
//
// 设计：LLM 根据用户自然语言自主决定调用哪个工具（function calling），
//       代码在权限门禁下执行工具，结果回灌给 LLM。加新功能 = 在这里加一个工具定义，
//       无需改动主流程 handleEvent。
//
// 安全模型（延续主人机制）：
//   - ownerOnly: true       → 仅主人可用，访客调用直接拒绝
//   - protectsOwner: true   → 结果可能含主人隐私，访客调用时过滤掉主人本人的数据
//   每次执行都由 executeTool 做权限校验，不依赖 LLM 自觉。

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { authorizeTool, classifyLarkArgs, getToolPolicy } from './policy.mjs';
import { runLark } from './lark.mjs';
import { describeImage, listModelIds, setRuntimeDefaultModel, currentDefaultModelId } from './reply.mjs';

const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID || '';
const OWNER_NAME = process.env.OWNER_NAME || '主人';

// feishu-skill 文档根目录：默认放在本地忽略目录 .local/skills/feishu-skill，可用 FEISHU_SKILL_ROOT 覆盖。
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKILL_ROOT = resolve(process.env.FEISHU_SKILL_ROOT || join(__dirname, '..', '.local', 'skills', 'feishu-skill'));
const AUTH_CARD_FLOW = join(SKILL_ROOT, 'scripts', 'feishu_oauth_card_flow.py');

// ============ feishu-skill 文档读取（供 read_skill / list_skills）============
// 安全地读取 SKILL_ROOT 下的文件，禁止路径穿越
function safeReadSkill(relPath) {
  const clean = normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  const full = resolve(SKILL_ROOT, clean);
  if (full !== SKILL_ROOT && !full.startsWith(SKILL_ROOT + sep)) return null; // 越界保护
  if (!existsSync(full)) return null;
  try { return readFileSync(full, 'utf8'); } catch { return null; }
}

function supportsIdentityFlag(args = []) {
  const root = String(args[0] || '');
  // auth/config/update 是 lark-cli 全局命令，不接受 --as。
  return !['auth', 'config', 'update'].includes(root);
}

function runProcess(bin, args, { timeoutMs = 310000, maxOutputBytes = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let out = '';
    let err = '';
    let settled = false;
    let closed = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const collect = (target, chunk) => {
      const next = target + chunk.toString();
      return Buffer.byteLength(next) > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };
    child.stdout.on('data', (d) => { out = collect(out, d); });
    child.stderr.on('data', (d) => { err = collect(err, d); });
    child.on('error', (e) => finish({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => {
      closed = true;
      finish({ code, out, err });
    });
    timer = setTimeout(() => {
      if (!closed) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (!closed) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 1000).unref();
      }
      finish({ code: -1, out, err: `执行超时（${timeoutMs}ms）` });
    }, timeoutMs);
    timer.unref();
  });
}

// ============ 公共 helper（供一等工具复用）============
// 人名 → 通讯录候选（含 open_id / 邮箱 / 部门）。供 lookup_user 及各写工具（参会人/受派人/收件人）复用。
// 返回 { ok:true, candidates:[{name,department,email,openId}] } | { ok:false, reason }
async function resolvePersonToOpenId(name) {
  const q = String(name || '').trim();
  if (!q) return { ok: false, reason: '缺少姓名' };
  const r = await runLark(['contact', '+search-user', '--query', q, '--as', 'user']);
  const candidates = (r.json?.data?.users || []).map((u) => ({
    name: u.localized_name || u.name || '',
    department: u.department || '',
    email: u.enterprise_email || u.email || '',
    openId: u.open_id || '',
  })).filter((u) => u.openId);
  if (candidates.length === 0) return { ok: false, reason: `通讯录里没找到「${q}」` };
  return { ok: true, candidates };
}

async function fetchChatMessages(chatId, { limit = 50, sort = 'desc', start = '' } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  const messages = [];
  let pageToken = '';
  while (messages.length < max) {
    const args = [
      'im', '+chat-messages-list', '--chat-id', chatId, '--as', 'bot',
      '--sort', sort, '--page-size', String(Math.min(50, max - messages.length)),
    ];
    if (start) args.push('--start', String(start));
    if (pageToken) args.push('--page-token', pageToken);
    const r = await runLark(args);
    if (r.code !== 0 || r.json?.ok === false) {
      return { error: (r.err || r.out || '拉取群消息失败').slice(0, 800), messages: [] };
    }
    const data = r.json?.data || {};
    const page = data.messages || data.items || [];
    messages.push(...page);
    if (!data.has_more || !data.page_token || page.length === 0) break;
    pageToken = data.page_token;
  }
  return { messages: messages.slice(0, max) };
}

function detectImageMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

async function renderMessageContent(message, imageBudget) {
  const content = String(message.content || '').replace(/\s+/g, ' ').trim();
  const image = content.match(/\[Image:\s*([^\]\s]+)\]/i);
  if (!image || imageBudget.remaining <= 0 || !message.message_id) return content;
  imageBudget.remaining -= 1;
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-image-'));
  const output = join(dir, 'image.bin');
  try {
    const r = await runLark([
      'im', '+messages-resources-download',
      '--message-id', message.message_id,
      '--file-key', image[1],
      '--type', 'image',
      '--output', output,
      '--as', 'bot',
    ]);
    if (r.code !== 0 || !existsSync(output)) return content;
    const buf = readFileSync(output);
    const description = await describeImage(buf.toString('base64'), { mime: detectImageMime(buf) });
    return description ? `[图片：${description}]` : content;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function getRecentChatContext(chatId, { limit = 15, messageId = '', includeImages = true } = {}) {
  if (!chatId) return { error: '当前不是群聊，没有群聊上下文可读', messages: [], text: '' };
  const n = Math.max(1, Math.min(50, Number(limit) || 15));
  const fetched = await fetchChatMessages(chatId, { limit: n + 1, sort: 'desc' });
  if (fetched.error) return { error: fetched.error, messages: [], text: '' };
  const raw = fetched.messages
    .filter((m) => !m.deleted && m.message_id !== messageId)
    .slice(0, n)
    .reverse();
  const imageBudget = { remaining: includeImages ? 3 : 0 };
  const messages = [];
  for (const m of raw) {
    const content = await renderMessageContent(m, imageBudget);
    if (!content) continue;
    messages.push({
      sender: m.sender?.name || '某人',
      content,
    });
  }
  const text = messages.map((m) => `${m.sender}：${m.content}`).join('\n');
  return { count: messages.length, messages, text };
}

// 单命令写操作的二次确认：登记待执行命令，返回给 LLM 的 needConfirm 结果（运行时 guard 会短路转达）。
// 主人回复带确认码的「确认 ABC123」后，bot.mjs 的 runAgentWithConfirm 会直接 runLark(pending.args)。
function confirmSingleWrite(ctx, finalArgs, preview, toolName = 'write') {
  const confirmToken = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const basePreview = String(preview || '')
    .replace(/\n?请?回复「确认」[^\n。]*(?:。)?/g, '')
    .trimEnd();
  const message = `${basePreview}\n确认码：${confirmToken}\n请回复「确认 ${confirmToken}」执行，或「取消」放弃。`;
  const action = {
    id: randomUUID(),
    toolName,
    args: finalArgs,
    preview: message,
    confirmToken,
    createdAt: Date.now(),
  };
  if (typeof ctx.registerPendingWrite === 'function') ctx.registerPendingWrite(action);
  console.log(`[tool] 待确认(写) action=${action.id.slice(0, 8)} tool=${toolName}`);
  return { needConfirm: true, actionId: action.id, confirmToken, message };
}

// ============ 网络访问（web_fetch / web_search）：安全护栏 + 抓取 ============
// 网络访问参数
const WEB_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS || 12000);
const WEB_MAX_BYTES = Number(process.env.WEB_MAX_BYTES || 1_500_000); // 抓取正文上限 ~1.5MB
const WEB_UA = process.env.WEB_UA || 'Mozilla/5.0 (compatible; LarkBot/1.0; +https://bytedance.com)';

function normalizeIpLiteral(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s;
}

function ipv4FromMappedIpv6(ip) {
  const s = normalizeIpLiteral(ip);
  if (!s.includes(':')) return '';
  const dotted = s.match(/^(?:::)?(?:0:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = s.match(/^(?:::)?(?:0:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return '';
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return '';
  const n = (hi << 16) | lo;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

// SSRF 防护：判断一个 IP 字符串是否属于「私有 / 环回 / 链路本地 / 云元数据」等禁止访问网段。
// 命中即拒绝，防止有人借机器人探测内网或读取云元数据（169.254.169.254）。
function isBlockedIp(ip) {
  const s = normalizeIpLiteral(ip);
  const mapped = ipv4FromMappedIpv6(s);
  if (mapped) return isBlockedIp(mapped);
  // IPv6 环回 / 未指定 / 链路本地 / 唯一本地地址(fc00::/7) / IPv4 映射
  if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 非 IPv4 字面量（域名会在别处经 DNS 解析后再查）
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // 环回
  if (a === 0) return true;                         // 0.0.0.0/8
  if (a === 169 && b === 254) return true;          // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                        // 组播 / 保留
  return false;
}

// 校验 URL 是否可安全访问：仅 http(s)、主机名不是内网字面量、DNS 解析出的 IP 也不在禁止网段。
// allowHost：显式放行的主机名（内网搜索 provider 用——该 host 由可信的 .env 配置指定，非用户输入）。
// 返回 { ok:true } | { ok:false, reason }
async function vetPublicUrl(rawUrl, allowHost = '') {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'URL 格式不正确' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http/https 链接' };
  }
  const host = u.hostname.toLowerCase();
  // 配置显式放行的内网 host（可信来源），直接通过——用于对接内网搜索 API。
  if (allowHost && host === allowHost.toLowerCase()) return { ok: true };
  // 主机名黑名单：localhost / .internal / .local 等
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: '不允许访问内网/本地地址' };
  }
  // 主机名本身就是内网 IP 字面量
  if (isBlockedIp(host)) return { ok: false, reason: '不允许访问内网/本地地址' };
  // 域名：DNS 解析，任一解析结果落在禁止网段即拒绝（防 DNS rebinding / 内网域名）
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
    try {
      const addrs = await dnsLookup(host, { all: true });
      if (addrs.some((r) => isBlockedIp(r.address))) {
        return { ok: false, reason: '目标解析到内网地址，已拒绝' };
      }
    } catch {
      return { ok: false, reason: `无法解析域名：${host}` };
    }
  }
  return { ok: true };
}

async function readResponseLimited(resp) {
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > WEB_MAX_BYTES) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, reason: `响应过大（上限 ${WEB_MAX_BYTES} bytes）` };
  }
  if (!resp.body) return { ok: true, body: '' };

  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remain = WEB_MAX_BYTES - total;
      if (remain <= 0) {
        await reader.cancel();
        break;
      }
      chunks.push(value.length > remain ? value.slice(0, remain) : value);
      total += Math.min(value.length, remain);
      if (total >= WEB_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, body: new TextDecoder('utf-8', { fatal: false }).decode(merged) };
}

// 安全抓取：每一跳都做 SSRF 校验、手动控制重定向，并用流式读取真正限制响应体。
// opts.method / opts.body / opts.headers 可选（web_search 用 POST 表单）。
async function safeHttpGet(rawUrl, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  let currentUrl = String(rawUrl);
  let method = opts.method || 'GET';
  let body = opts.body;
  let redirects = 0;
  const headers = {
    'User-Agent': WEB_UA,
    Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    ...(opts.headers || {}),
  };
  try {
    while (true) {
      const vet = await vetPublicUrl(currentUrl, opts.allowHost || '');
      if (!vet.ok) return { ok: false, reason: vet.reason };
      const resp = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) return { ok: false, reason: `重定向缺少 Location（HTTP ${resp.status}）` };
        if (++redirects > 5) return { ok: false, reason: '重定向次数过多' };
        const next = new URL(location, currentUrl);
        if (opts.allowHost && next.hostname.toLowerCase() !== opts.allowHost.toLowerCase()) {
          return { ok: false, reason: '带鉴权的内网请求不允许跨主机重定向' };
        }
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method !== 'GET')) {
          method = 'GET';
          body = undefined;
          delete headers['Content-Type'];
          delete headers['content-type'];
        }
        currentUrl = next.toString();
        continue;
      }
      const read = await readResponseLimited(resp);
      if (!read.ok) return read;
      return {
        ok: true,
        status: resp.status,
        finalUrl: currentUrl,
        contentType: resp.headers.get('content-type') || '',
        body: read.body,
      };
    }
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '请求超时' : `请求失败：${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// 把 HTML 粗略转成纯文本：去 script/style、去标签、解码常见实体、压缩空白。
function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  t = t.replace(/[ \t\u00A0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

// 解析 DuckDuckGo HTML 端点的结果页，抽出前 n 条 { title, snippet, url }。
// DDG 的真实跳转链接被包在 /l/?uddg=<encoded> 里，需解出真实 URL。
function parseDuckDuckGo(html, n) {
  const out = [];
  const src = String(html || '');
  // 每条结果的标题锚点：<a ... class="result__a" href="...">标题</a>
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(src)) && out.length < n) {
    let href = m[1];
    // 解出 DDG 包裹的真实链接
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) { try { href = decodeURIComponent(ud[1]); } catch { /* keep */ } }
    else if (href.startsWith('//')) href = 'https:' + href;
    const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    // 摘要：从该锚点往后就近找一个 result__snippet
    const after = src.slice(m.index, m.index + 1500);
    const sm = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sm ? htmlToText(sm[1]).replace(/\s+/g, ' ').trim() : '';
    if (title && /^https?:\/\//i.test(href)) out.push({ title, snippet: snippet.slice(0, 300), url: href });
  }
  return out;
}

// 解析 Bing 结果页：标题+链接在 <h2><a href>标题</a></h2>，摘要就近取 b_lineclamp/b_caption。
function parseBing(html, n) {
  const out = [];
  const src = String(html || '');
  const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi;
  let m;
  while ((m = re.exec(src)) && out.length < n) {
    const href = m[1];
    const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!title || !/^https?:\/\//i.test(href)) continue; // 跳过站内/广告等非常规条目
    // 摘要：从标题往后就近找 b_lineclamp 或 b_caption 里的段落
    const after = src.slice(m.index, m.index + 2500);
    const sm = after.match(/class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
            || after.match(/class="[^"]*b_caption[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sm ? htmlToText(sm[1]).replace(/\s+/g, ' ').trim() : '';
    out.push({ title, snippet: snippet.slice(0, 300), url: href });
  }
  return out;
}

// ============ 搜索 provider（可切换：bing 默认 / ddg / internal）============
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'bing').toLowerCase();
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Bing（公网，服务端渲染，无需 key，实测最稳）
async function searchBing(q, n) {
  const url = 'https://www.bing.com/search?setlang=zh-CN&q=' + encodeURIComponent(q);
  const r = await safeHttpGet(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh' } });
  if (!r.ok) return { error: `搜索失败：${r.reason}` };
  return { results: parseBing(r.body, n) };
}

// DuckDuckGo（公网备选，POST 表单 + 浏览器 UA 绕反爬）
async function searchDDG(q, n) {
  const r = await safeHttpGet('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q, kl: 'cn-zh' }).toString(),
  });
  if (!r.ok) return { error: `搜索失败：${r.reason}` };
  return { results: parseDuckDuckGo(r.body, n) };
}

// 内网搜索（endpoint / 鉴权 / 字段映射全走 .env，代码不写死任何内网地址）。
// 需要的环境变量：
//   SEARCH_INTERNAL_URL          必填，如 https://xxx.bytedance.net/api/search?q={query}&size={n}
//   SEARCH_INTERNAL_TOKEN        可选，鉴权凭证
//   SEARCH_INTERNAL_TOKEN_HEADER 可选，token 放哪个头，默认 Authorization（值形如 "Bearer xxx" 由 PREFIX 控制）
//   SEARCH_INTERNAL_TOKEN_PREFIX 可选，token 前缀，默认 "Bearer "（设为空串则直接用 token）
//   SEARCH_INTERNAL_RESULT_PATH  可选，结果数组在 JSON 里的路径，点号分隔，如 data.results，默认自动探测
//   SEARCH_INTERNAL_FIELD_TITLE/URL/SNIPPET  可选，条目字段名，默认 title/url/snippet
async function searchInternal(q, n) {
  const base = process.env.SEARCH_INTERNAL_URL;
  if (!base) {
    return { error: '内网搜索尚未配置（SEARCH_INTERNAL_URL 为空）。请在 .env 填入内网搜索 API 地址后再用，或改用 SEARCH_PROVIDER=bing。' };
  }
  const url = base.includes('{query}')
    ? base.replace('{query}', encodeURIComponent(q)).replace('{n}', String(n))
    : base + (base.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q);
  const headers = { 'User-Agent': WEB_UA, Accept: 'application/json' };
  const token = process.env.SEARCH_INTERNAL_TOKEN;
  if (token) {
    const h = process.env.SEARCH_INTERNAL_TOKEN_HEADER || 'Authorization';
    const prefix = process.env.SEARCH_INTERNAL_TOKEN_PREFIX ?? 'Bearer ';
    headers[h] = prefix + token;
  }
  // 内网 host 通常是 10.x 私有段，会被 SSRF 防护拦；显式放行「配置里指定的这个 host」。
  const r = await safeHttpGet(url, { headers, allowHost: (() => { try { return new URL(url).hostname; } catch { return ''; } })() });
  if (!r.ok) return { error: `内网搜索失败：${r.reason}` };
  let json;
  try { json = JSON.parse(r.body); } catch { return { error: '内网搜索返回的不是合法 JSON，请检查 SEARCH_INTERNAL_URL' }; }
  // 定位结果数组
  let arr = null;
  const path = process.env.SEARCH_INTERNAL_RESULT_PATH;
  if (path) {
    arr = path.split('.').reduce((o, k) => (o == null ? o : o[k]), json);
  } else {
    arr = Array.isArray(json) ? json : (json.results || json.data?.results || json.data?.items || json.items || json.data);
  }
  if (!Array.isArray(arr)) return { error: '未能从内网搜索结果里定位到条目数组，请配置 SEARCH_INTERNAL_RESULT_PATH' };
  const fT = process.env.SEARCH_INTERNAL_FIELD_TITLE || 'title';
  const fU = process.env.SEARCH_INTERNAL_FIELD_URL || 'url';
  const fS = process.env.SEARCH_INTERNAL_FIELD_SNIPPET || 'snippet';
  const results = arr.slice(0, n).map((it) => ({
    title: String(it[fT] ?? '').slice(0, 200),
    url: String(it[fU] ?? ''),
    snippet: String(it[fS] ?? '').replace(/\s+/g, ' ').slice(0, 300),
  })).filter((x) => x.title || x.url);
  return { results };
}

// ============ 工具定义 ============
// 每个工具：{ name, description, parameters, ownerOnly?, protectsOwner?, run(args, ctx) }
// ctx 提供：{ isOwner, senderName, chatId }
const TOOLS = [
  {
    name: 'lookup_user',
    description: '根据姓名查询同事的部门、邮箱等通讯录信息。用于"XX是谁""XX的邮箱/部门是什么"等问题。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要查询的人名' } },
      required: ['name'],
    },
    protectsOwner: true, // 访客不可查到主人本人
    async run({ name }, ctx) {
      const rp = await resolvePersonToOpenId(name);
      if (!rp.ok) return { users: [], note: rp.reason };
      let users = rp.candidates;
      if (!ctx.isOwner) {
        const before = users.length;
        users = users.filter((u) => u.openId !== OWNER_OPEN_ID); // 屏蔽主人本人
        if (before > 0 && users.length === 0) {
          return { refused: true, message: `${OWNER_NAME}的个人信息不便提供` };
        }
      }
      // 不把 openId 回灌给 LLM
      return { users: users.map(({ openId, ...rest }) => rest) };
    },
  },

  {
    name: 'get_chat_members',
    description: '获取当前群聊的成员列表（姓名）。用于"群里都有谁""这个群有多少人"等问题。仅在群聊中可用。',
    parameters: { type: 'object', properties: {}, required: [] },
    protectsOwner: true, // 访客看群成员时隐去主人本人
    async run(_args, ctx) {
      if (!ctx.chatId) return { error: '当前不是群聊，无法获取群成员' };
      const r = await runLark(['im', '+chat-members-list', '--chat-id', ctx.chatId, '--as', 'bot']);
      // 保留 member_id（open_id）用于精确匹配主人；访客场景滤掉主人后再只回姓名
      let members = (r.json?.data?.users || r.json?.data?.items || [])
        .map((m) => ({ name: m.name, openId: m.member_id || m.open_id || '' }))
        .filter((m) => m.name);
      if (!ctx.isOwner) {
        members = members.filter((m) => m.openId !== OWNER_OPEN_ID); // 屏蔽主人本人
      }
      const names = members.map((m) => m.name);
      return { count: names.length, members: names };
    },
  },

  {
    name: 'get_user_recent_messages',
    description:
      '获取当前群聊里「指定某个人」最近发送的聊天消息。用于"XX刚才说了什么""XX最近发了啥"等问题。仅在群聊中可用。',
    parameters: {
      type: 'object',
      properties: {
        person_name: { type: 'string', description: '要查询其消息的群成员姓名' },
        limit: { type: 'number', description: '返回最近多少条，默认 10' },
      },
      required: ['person_name'],
    },
    protectsOwner: true, // 访客不可查主人发的消息
    async run({ person_name, limit = 10 }, ctx) {
      if (!ctx.chatId) return { error: '当前不是群聊，无法查询群消息' };
      const target = String(person_name || '').trim();
      if (!ctx.isOwner && (target === OWNER_NAME)) {
        return { refused: true, message: `不便提供${OWNER_NAME}的聊天内容` };
      }
      const fetched = await fetchChatMessages(ctx.chatId, { limit: 200, sort: 'desc' });
      if (fetched.error) return { error: fetched.error };
      const selected = fetched.messages
        .filter((m) => !m.deleted && (m.sender?.name === target))
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
      const imageBudget = { remaining: 2 };
      const msgs = [];
      for (const m of selected) {
        msgs.push({ time: m.create_time, content: await renderMessageContent(m, imageBudget) });
      }
      if (msgs.length === 0) return { messages: [], note: `最近没有找到「${target}」发送的消息` };
      return { person: target, messages: msgs };
    },
  },

  {
    name: 'summarize_chat',
    description: '总结当前群聊最近一段时间的聊天记录。用于"总结一下群里聊了啥""梳理今天的讨论"等。仅在群聊中可用。',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '总结最近多少小时，默认 24' },
        limit: { type: 'number', description: '最多读取多少条，默认 200，最大 200' },
      },
      required: [],
    },
    async run({ hours = 24, limit = 200 }, ctx) {
      if (!ctx.chatId) return { error: '当前不是群聊，无法总结群消息' };
      const startSec = String(Math.floor((Date.now() - Number(hours) * 3600 * 1000) / 1000));
      const fetched = await fetchChatMessages(ctx.chatId, { limit, sort: 'asc', start: startSec });
      if (fetched.error) return { error: fetched.error };
      const imageBudget = { remaining: 3 };
      const lines = [];
      for (const m of fetched.messages.filter((item) => !item.deleted)) {
        const content = await renderMessageContent(m, imageBudget);
        if (content) lines.push(`${m.sender?.name || '某人'}：${content}`);
      }
      if (lines.length === 0) return { transcript: '', note: `最近 ${hours} 小时没有可总结的消息` };
      // 直接把记录回灌给 LLM，由它在编排循环里总结（避免二次调用）
      return { hours, count: lines.length, transcript: lines.join('\n').slice(0, 6000) };
    },
  },

  {
    name: 'get_recent_chat_context',
    description:
      '获取当前群聊「最近的若干条聊天记录」作为上下文，每条都带【发送者姓名】，按时间从早到晚排列。' +
      '当用户在群里 @你 说的话带有指代或延续语气、暗含要看前面大家聊了什么才能回答时——' +
      '例如“你怎么看这事”“他说得对吗”“接着刚才的说”“大家在争论啥”“帮我评评理”——' +
      '先用本工具把上下文读进来，再结合着自然地回应。仅在群聊中可用。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '拉取最近多少条，默认 15，最多 50' },
      },
      required: [],
    },
    async run({ limit = 15 }, ctx) {
      const { error, messages } = await getRecentChatContext(ctx.chatId, {
        limit,
        messageId: ctx.messageId,
        includeImages: true,
      });
      if (error) return { error };
      if (messages.length === 0) {
        return { messages: [], note: '当前群暂时没有可读的最近消息' };
      }
      return { count: messages.length, messages };
    },
  },

  // ============ 一等工具：日程（calendar，全部 ownerOnly，读主人私有资源用 --as user）============
  {
    name: 'calendar_agenda',
    description:
      '查看主人近期的日程安排（只读）。用于"我今天/明天/这周有什么安排""看下我的日程"等。' +
      '不传参默认查今天；可传 ISO8601 或 YYYY-MM-DD 的起止时间。',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始时间，ISO8601 或 YYYY-MM-DD，缺省今天' },
        end: { type: 'string', description: '结束时间，缺省与 start 同一天' },
      },
      required: [],
    },
    ownerOnly: true,
    async run({ start, end }) {
      const a = ['calendar', '+agenda'];
      if (start) a.push('--start', String(start));
      if (end) a.push('--end', String(end));
      a.push('--as', 'user');
      const r = await runLark(a);
      if (r.code !== 0) return { error: (r.err || r.out || '查询日程失败').slice(0, 800) };
      const data = r.json ? (r.json.data ?? r.json) : r.out;
      const arr = Array.isArray(data) ? data : (data ? [data] : []);
      if (arr.length === 0) return { agenda: [], note: '这段时间没有日程安排' };
      return { agenda: JSON.stringify(data).slice(0, 6000) };
    },
  },

  {
    name: 'calendar_create',
    description:
      '为主人创建一个日程，可邀请参会人（写操作，需主人二次确认）。' +
      'start/end 必须是 ISO8601（含时区，如 2026-07-31T14:00+08:00）。标题里不要写时间/地点/人物。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '日程标题' },
        start: { type: 'string', description: '开始时间，ISO8601 含时区' },
        end: { type: 'string', description: '结束时间，ISO8601 含时区' },
        description: { type: 'string', description: '日程描述，可选' },
        attendee_names: { type: 'array', items: { type: 'string' }, description: '参会人姓名列表，可选（工具内部解析成 open_id）' },
      },
      required: ['summary', 'start', 'end'],
    },
    ownerOnly: true,
    async run({ summary, start, end, description, attendee_names }, ctx) {
      const ids = [];
      for (const nm of attendee_names || []) {
        const rp = await resolvePersonToOpenId(nm);
        if (!rp.ok) return { error: `参会人「${nm}」解析失败：${rp.reason}` };
        if (rp.candidates.length > 1) {
          return { needClarify: true, forName: nm, candidates: rp.candidates.map(({ openId, ...x }) => x) };
        }
        ids.push(rp.candidates[0].openId);
      }
      const a = ['calendar', '+create', '--summary', String(summary), '--start', String(start), '--end', String(end)];
      if (description) a.push('--description', String(description));
      if (ids.length) a.push('--attendee-ids', ids.join(','));
      a.push('--as', 'user');
      const who = (attendee_names && attendee_names.length) ? `，参会人 ${attendee_names.join('、')}` : '';
      const preview = `将为你创建日程：「${summary}」\n时间：${start} ~ ${end}${who}\n回复「确认」创建，或「取消」放弃。`;
      return confirmSingleWrite(ctx, a, preview, 'calendar_create');
    },
  },

  // ============ 一等工具：任务（task，ownerOnly，--as user）============
  {
    name: 'task_list',
    description:
      '查看/搜索分配给主人的任务清单（只读）。用于"我有哪些待办""搜下关于XX的任务"等。可传 query 按任务名搜索。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '按任务名搜索的关键词，可空' } },
      required: [],
    },
    ownerOnly: true,
    async run({ query }) {
      const a = ['task', '+get-my-tasks'];
      if (query) a.push('--query', String(query));
      a.push('--as', 'user');
      const r = await runLark(a);
      if (r.code !== 0) return { error: (r.err || r.out || '查询任务失败').slice(0, 800) };
      const data = r.json ? (r.json.data ?? r.json) : r.out;
      return { tasks: JSON.stringify(data).slice(0, 6000) };
    },
  },

  {
    name: 'task_create',
    description:
      '为主人创建一个待办任务（写操作，需主人二次确认）。不指定受派人时默认分配给主人自己。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '任务标题' },
        due: { type: 'string', description: '截止时间，支持 YYYY-MM-DD / +2d / ISO8601，可选' },
        assignee_name: { type: 'string', description: '受派人姓名，缺省即主人自己，可选' },
        description: { type: 'string', description: '任务描述，可选' },
      },
      required: ['summary'],
    },
    ownerOnly: true,
    async run({ summary, due, assignee_name, description }, ctx) {
      const a = ['task', '+create', '--summary', String(summary)];
      if (description) a.push('--description', String(description));
      if (due) a.push('--due', String(due));
      if (assignee_name) {
        const rp = await resolvePersonToOpenId(assignee_name);
        if (!rp.ok) return { error: `受派人「${assignee_name}」解析失败：${rp.reason}` };
        if (rp.candidates.length > 1) {
          return { needClarify: true, forName: assignee_name, candidates: rp.candidates.map(({ openId, ...x }) => x) };
        }
        a.push('--assignee', rp.candidates[0].openId);
      }
      a.push('--as', 'user');
      const preview = `将创建任务：「${summary}」${due ? `（截止 ${due}）` : ''}${assignee_name ? `，指派给 ${assignee_name}` : ''}。\n回复「确认」创建，或「取消」放弃。`;
      return confirmSingleWrite(ctx, a, preview, 'task_create');
    },
  },

  // ============ 一等工具：IM 发消息（send_message，ownerOnly，以 bot 身份发）============
  {
    name: 'send_message',
    description:
      '以机器人身份代主人发送一条消息给某个人或当前群（写操作，需主人二次确认）。' +
      '用于"帮我给张三发条消息说…""在群里通知一下…"。私发指定 to_user_name；发到当前群用 to_current_chat=true。',
    parameters: {
      type: 'object',
      properties: {
        to_user_name: { type: 'string', description: '收件人姓名（私发），与 to_current_chat 二选一' },
        to_current_chat: { type: 'boolean', description: '为 true 时发到当前群，与 to_user_name 二选一' },
        text: { type: 'string', description: '纯文本内容（与 markdown 二选一）' },
        markdown: { type: 'string', description: 'markdown 内容（与 text 二选一）' },
      },
      required: [],
    },
    ownerOnly: true,
    async run({ to_user_name, to_current_chat, text, markdown }, ctx) {
      if (!text && !markdown) return { error: '缺少消息内容' };
      const a = ['im', '+messages-send'];
      let who;
      if (to_current_chat) {
        if (!ctx.chatId) return { error: '当前不是群聊，无法发到当前群' };
        a.push('--chat-id', ctx.chatId);
        who = '当前群';
      } else if (to_user_name) {
        const rp = await resolvePersonToOpenId(to_user_name);
        if (!rp.ok) return { error: `收件人「${to_user_name}」解析失败：${rp.reason}` };
        if (rp.candidates.length > 1) {
          return { needClarify: true, forName: to_user_name, candidates: rp.candidates.map(({ openId, ...x }) => x) };
        }
        a.push('--user-id', rp.candidates[0].openId);
        who = to_user_name;
      } else {
        return { error: '需指定收件人：to_user_name 或 to_current_chat' };
      }
      if (text) a.push('--text', String(text));
      else a.push('--markdown', String(markdown));
      a.push('--as', 'bot');
      const preview = `将向【${who}】发送：\n${text || markdown}\n回复「确认」发送，或「取消」放弃。`;
      return confirmSingleWrite(ctx, a, preview, 'send_message');
    },
  },

  // ============ 一等工具：邮件（mail，ownerOnly，--as user）============
  {
    name: 'mail_triage',
    description:
      '查看主人收件箱的邮件摘要（只读）。用于"看下我的邮件""有没有关于合同的邮件"。可传 query 全文搜索。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '全文搜索关键词，可空' } },
      required: [],
    },
    ownerOnly: true,
    async run({ query }) {
      const a = ['mail', '+triage', '--format', 'json'];
      if (query) a.push('--query', String(query));
      a.push('--as', 'user');
      const r = await runLark(a);
      if (r.code !== 0) return { error: (r.err || r.out || '查询邮件失败').slice(0, 800) };
      const data = r.json ? (r.json.data ?? r.json) : r.out;
      return { mails: JSON.stringify(data).slice(0, 6000) };
    },
  },

  {
    name: 'mail_send',
    description:
      '代主人发送一封新邮件（写操作，需主人二次确认）。收件人可给邮箱 to，或给姓名 to_name（工具解析其邮箱）。正文推荐 HTML。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人邮箱，多个逗号分隔；与 to_name 二选一' },
        to_name: { type: 'string', description: '收件人姓名（工具解析成邮箱）；与 to 二选一' },
        subject: { type: 'string', description: '邮件主题' },
        body: { type: 'string', description: '邮件正文，推荐 HTML' },
        cc: { type: 'string', description: '抄送邮箱，多个逗号分隔，可选' },
      },
      required: ['subject', 'body'],
    },
    ownerOnly: true,
    async run({ to, to_name, subject, body, cc }, ctx) {
      let toAddr = to;
      if (!toAddr && to_name) {
        const rp = await resolvePersonToOpenId(to_name);
        if (!rp.ok) return { error: `收件人「${to_name}」解析失败：${rp.reason}` };
        if (rp.candidates.length > 1) {
          return { needClarify: true, forName: to_name, candidates: rp.candidates.map(({ openId, ...x }) => x) };
        }
        toAddr = rp.candidates[0].email;
        if (!toAddr) return { error: `收件人「${to_name}」没有可用邮箱` };
      }
      if (!toAddr) return { error: '缺少收件人（to 邮箱或 to_name 姓名）' };
      // 确认后一步直发：mail +send --confirm-send 直接发送（无需先建草稿再 drafts send）
      const a = ['mail', '+send', '--to', String(toAddr), '--subject', String(subject), '--body', String(body)];
      if (cc) a.push('--cc', String(cc));
      a.push('--confirm-send', '--as', 'user');
      const bodyPreview = String(body).replace(/<[^>]+>/g, '').slice(0, 120);
      const preview = `将发送邮件：\n收件人：${toAddr}${cc ? `\n抄送：${cc}` : ''}\n主题：${subject}\n正文预览：${bodyPreview}…\n回复「确认」发送，或「取消」放弃。`;
      return confirmSingleWrite(ctx, a, preview, 'mail_send');
    },
  },

  // ============ 一等工具：网络访问（web_search / web_fetch，任何人可用，只读、带 SSRF 防护）============
  {
    name: 'web_fetch',
    description:
      '抓取一个网页链接的正文内容（只读）。用于"帮我看下这个链接讲了啥""总结下这篇文章 https://…"。' +
      '仅支持公网 http/https 链接；会自动拒绝内网/本地地址。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的网页 URL（http/https）' } },
      required: ['url'],
    },
    async run({ url }) {
      const r = await safeHttpGet(url);
      if (!r.ok) return { error: r.reason };
      const isHtml = /html/i.test(r.contentType) || /^\s*</.test(r.body);
      const text = isHtml ? htmlToText(r.body) : r.body;
      if (!text.trim()) return { url, status: r.status, note: '页面没有可提取的文本内容' };
      // 正文回灌给 LLM 由它总结/问答（截断，避免超长）
      return { url, status: r.status, content: text.slice(0, 6000) };
    },
  },

  {
    name: 'web_search',
    description:
      '联网搜索关键词，返回相关网页的标题、摘要和链接（只读）。用于"搜一下最近的 XX""查查 YY 是什么"等需要实时/外部信息的问题。' +
      '拿到结果后可再用 web_fetch 打开某条链接读全文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果条数，默认 5，最多 10' },
      },
      required: ['query'],
    },
    async run({ query, limit = 5 }) {
      const q = String(query || '').trim();
      if (!q) return { error: '缺少搜索关键词' };
      const n = Math.max(1, Math.min(10, Number(limit) || 5));
      // 按 SEARCH_PROVIDER 分派：bing（默认，公网服务端渲染最稳）/ ddg（公网备选）/ internal（内网 API，走 .env）
      let res;
      if (SEARCH_PROVIDER === 'internal') res = await searchInternal(q, n);
      else if (SEARCH_PROVIDER === 'ddg') res = await searchDDG(q, n);
      else res = await searchBing(q, n);
      if (res.error) return { provider: SEARCH_PROVIDER, error: res.error };
      const results = res.results || [];
      if (results.length === 0) {
        return { provider: SEARCH_PROVIDER, query: q, results: [], note: '没有解析到搜索结果（可能结果页结构变化或无匹配）' };
      }
      return { provider: SEARCH_PROVIDER, query: q, results };
    },
  },

  // ============ 模型管理（仅主人）：查看/切换当前默认模型 ============
  {
    name: 'list_models',
    description: '列出当前可用的大模型，以及正在使用的默认模型。用于"有哪些模型""现在用的是哪个模型"。',
    parameters: { type: 'object', properties: {}, required: [] },
    run() {
      return { models: listModelIds(), current: currentDefaultModelId() };
    },
  },

  {
    name: 'switch_model',
    description:
      '切换机器人当前使用的默认大模型（仅主人可用，立即生效、无需重启，进程重启后回落 .env 配置）。' +
      '用于"换成 gpt-5""切到 gemini""用更强的模型回答"。可先用 list_models 看有哪些可选。',
    parameters: {
      type: 'object',
      properties: { model: { type: 'string', description: '目标模型名，需在可用模型列表中' } },
      required: ['model'],
    },
    run({ model }) {
      const res = setRuntimeDefaultModel(model);
      if (!res.ok) return { error: res.message, models: listModelIds() };
      return { ok: true, message: res.message, current: currentDefaultModelId() };
    },
  },

  {
    name: 'start_user_auth',
    description:
      '向当前主人发送飞书 user 授权卡片，并轮询等待授权完成。用于日历/任务/邮件/云文档等 --as user 能力缺少 scope 或提示需要 auth login 时。' +
      '不要用 run_lark_cli 执行 auth login；应调用本工具。scope 和 domain 二选一，推荐按错误提示传最小 scope。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: '空格分隔的 OAuth scope，如 calendar:calendar.event:read' },
        domain: { type: 'string', description: '业务域，如 calendar,task,mail；与 scope 二选一' },
        timeout: { type: 'number', description: '等待授权秒数，默认 300，最大 300' },
        target: { type: 'string', enum: ['p2p', 'current_chat'], description: '授权卡片发送位置，默认 p2p 私发给主人' },
        recommend: { type: 'boolean', description: '是否传给 lark-cli auth login --recommend' },
      },
      required: [],
    },
    ownerOnly: true,
    async run({ scope, domain, timeout = 300, target = 'p2p', recommend = false }, ctx) {
      const cleanScope = String(scope || '').trim();
      const cleanDomain = String(domain || '').trim();
      if (Boolean(cleanScope) === Boolean(cleanDomain)) {
        return { error: 'scope 和 domain 必须二选一。建议优先使用错误提示里的最小 scope。' };
      }
      if (!existsSync(AUTH_CARD_FLOW)) {
        return { error: `授权卡片脚本不存在：${AUTH_CARD_FLOW}` };
      }
      const args = [AUTH_CARD_FLOW];
      if (target === 'current_chat' && ctx.chatId) args.push('--chat-id', ctx.chatId);
      else if (ctx.senderId) args.push('--user-id', ctx.senderId);
      else if (ctx.chatId) args.push('--chat-id', ctx.chatId);
      else return { error: '缺少可发送授权卡片的会话目标（既没有 senderId，也没有 chatId）' };
      if (cleanScope) args.push('--scope', cleanScope);
      else args.push('--domain', cleanDomain);
      if (recommend) args.push('--recommend');
      const waitSec = Math.max(30, Math.min(300, Number(timeout) || 300));
      args.push('--timeout', String(waitSec));

      const r = await runProcess('python3', args, {
        cwd: SKILL_ROOT,
        timeoutMs: (waitSec + 15) * 1000,
        maxOutputBytes: 12000,
      });
      if (r.code === 0) {
        return { ok: true, message: '授权已完成，可以重试刚才需要 user 权限的操作。', output: (r.out || '').slice(-1200) };
      }
      if (r.code === 2) {
        return {
          error: '授权卡片已发送，但等待超时。请在飞书里打开授权卡片完成授权，然后重试刚才的操作。',
          detail: (r.err || r.out || '').slice(-2000),
        };
      }
      return { error: '发起授权卡片失败', detail: (r.err || r.out || '').slice(-2000) };
    },
  },

  // ============ 元工具：解锁 lark-cli 全部能力（读文档 + 拼命令执行）============
  {
    name: 'list_lark_skills',
    description:
      '列出可用的飞书能力域（日历/邮件/文档/知识库/多维表格/任务/会议等）及其适用场景。' +
      '当用户的需求超出已有专用工具、需要探索有哪些飞书能力时，先调用它做路由。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const md = safeReadSkill('SKILL.md');
      if (!md) return { error: '未找到 feishu-skill 文档' };
      // 提取路由表区块，避免回灌过长
      const idx = md.indexOf('## 子技能路由');
      const routing = idx >= 0 ? md.slice(idx, idx + 2500) : md.slice(0, 2500);
      return { routing };
    },
  },

  {
    name: 'read_lark_skill',
    description:
      '阅读某个飞书能力域的使用说明（SKILL.md 或其 references 下的具体命令文档），学习该域的 lark-cli 命令怎么用。' +
      '在调用 run_lark_cli 执行不熟悉的命令前，务必先用它读对应域的文档，不要凭记忆拼命令。' +
      '例：{"skill":"lark-doc"} 读文档域概览；{"skill":"lark-doc","ref":"lark-doc-create"} 读建文档的具体用法。',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '域名，如 lark-doc / lark-calendar / lark-task / lark-wiki 等' },
        ref: { type: 'string', description: '可选，references 下的文档名（不含 .md），如 lark-doc-create' },
      },
      required: ['skill'],
    },
    async run({ skill, ref }) {
      const safe = String(skill || '').replace(/[^a-z0-9-]/gi, '');
      if (!safe) return { error: '缺少 skill 名' };
      const rel = ref
        ? `skills/${safe}/references/${String(ref).replace(/[^a-z0-9-]/gi, '')}.md`
        : `skills/${safe}/SKILL.md`;
      const md = safeReadSkill(rel);
      if (!md) return { error: `未找到文档：${rel}` };
      return { path: rel, content: md.slice(0, 6000) };
    },
  },

  {
    name: 'run_lark_cli',
    description:
      '执行一条 lark-cli 命令来完成飞书操作（查询或写入）。参数 args 是命令的参数数组（不含 "lark-cli" 本身），' +
      '例如查日历：["calendar","+agenda"]；发消息：["im","+messages-send","--user-id","ou_xxx","--text","hi"]。' +
      '拼命令前应先用 read_lark_skill 学习该域用法。该元工具仅主人可用；无法确认只读的命令会按写操作要求二次确认。',
    parameters: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'lark-cli 参数数组，不含 lark-cli' },
        purpose: { type: 'string', description: '简述这条命令要做什么（便于日志与审计）' },
      },
      required: ['args'],
    },
    ownerOnly: true,
    async run({ args }, ctx) {
      const vet = classifyLarkArgs(args, { isOwner: ctx.isOwner });
      if (!vet.ok) {
        console.warn(`[tool] run_lark_cli 被拒：${vet.reason}`);
        return { refused: true, message: vet.reason };
      }
      // 默认强制 bot 身份读取（除非命令里已显式指定 --as）；auth/config/update 等全局命令不支持 --as。
      const finalArgs = (vet.args.includes('--as') || !supportsIdentityFlag(vet.args)) ? vet.args : [...vet.args, '--as', 'bot'];
      // 写操作二次确认：主人的写命令首次调用不直接执行，先登记待确认并返回提示。
      // 主人回复带确认码的「确认 ABC123」后，bot.mjs 的 runAgentWithConfirm 会直接执行登记的 finalArgs。
      if (vet.isWrite) {
        const preview = `这是一个写操作，将执行：lark-cli ${finalArgs.filter((a) => a !== '--as' && a !== 'bot').join(' ')}。`;
        return confirmSingleWrite(ctx, finalArgs, preview, 'run_lark_cli');
      }
      console.log(`[tool] run_lark_cli (读) service=${finalArgs[0] || '?'} action=${finalArgs[1] || '?'}`);
      const r = await runLark(finalArgs);
      if (r.code !== 0) {
        return { error: (r.err || r.out || '执行失败').slice(0, 800) };
      }
      // 回灌精简后的结果
      const out = r.json ? JSON.stringify(r.json.data ?? r.json) : r.out;
      return { ok: true, result: String(out).slice(0, 6000) };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// 给 LLM 的工具 schema（OpenAI function calling 格式）
export function getToolSchemas(ctx = {}) {
  return TOOLS
    .filter((t) => authorizeTool(t.name, {}, ctx).ok)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

export function getToolMetadata(name, args = {}) {
  const policy = getToolPolicy(name);
  if (name !== 'run_lark_cli') return policy;
  const classified = classifyLarkArgs(args.args, { isOwner: true });
  return { ...policy, effect: classified.ok && !classified.isWrite ? 'read' : 'write' };
}

// 执行工具（带权限门禁）。返回值会被 JSON 序列化回灌给 LLM。
export async function executeTool(name, args, ctx) {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { error: `未知工具：${name}` };
  const auth = authorizeTool(name, args || {}, ctx);
  if (!auth.ok) {
    console.warn(`[tool] 访问工具 ${name} 被策略拒绝：${auth.reason}`);
    return { refused: true, message: auth.reason };
  }
  try {
    const result = await tool.run(args || {}, ctx);
    return result;
  } catch (err) {
    console.error(`[tool] ${name} 执行异常：`, err.message);
    return { error: `工具执行失败：${err.message}` };
  }
}

export const __testing = Object.freeze({
  vetPublicUrl,
  safeHttpGet,
  readResponseLimited,
  supportsIdentityFlag,
});

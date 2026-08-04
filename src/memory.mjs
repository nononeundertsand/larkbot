// 三层对话记忆（按用户维度存储）+ 群共享记忆
//
//   1) 短期记忆：滑动窗口，最近 SHORT_TURNS 轮原文，存内存（重启清空）
//   2) 长期记忆：被挤出窗口的旧对话，用 LLM 压缩成滚动摘要，落盘持久化
//   3) 关键记忆：结构化事实 JSON（姓名/偏好/项目/待办…），落盘持久化，关键信息不遗忘
//
//   持久化布局（按用户分目录，方便人工查看/调整）：
//   data/memory/<用户名_openid短码>/
//     ├── profile.json          用户身份 {name, department, email, openId}
//     ├── p2p.json              私聊场景 {summary, facts, updatedAt}
//     └── group_<chatId>.json   各群场景 {summary, facts, updatedAt}
//   data/memory/groups/
//     └── group_<chatId>.json   群共享记忆 {summary, facts, updatedAt}
//   同一用户的所有会话集中在其目录内；短期原文不落盘。
//
// 维护时机（省成本）：回复后异步调用 maintainMemory()：
//   - 有旧轮次滑出窗口时 → 增量更新长期摘要
//   - 每满 EXTRACT_EVERY 轮 → 抽取/合并关键记忆

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { updateSummary, extractKeyMemory, updateGroupSummary, extractGroupKeyMemory } from './reply.mjs';

const SHORT_TURNS = Number(process.env.MEMORY_SHORT_TURNS || 30); // 短期滑动窗口轮数
const TTL_MS = Number(process.env.MEMORY_TTL_MS || 30 * 60 * 1000); // 短期无活动过期
const MAX_SESSIONS = Number(process.env.MEMORY_MAX_SESSIONS || 1000);
const EXTRACT_EVERY = Number(process.env.MEMORY_EXTRACT_EVERY || 5); // 每几轮抽取一次关键记忆
const CONTEXT_BUDGET_CHARS = Number(process.env.MEMORY_CONTEXT_BUDGET_CHARS || 12000);
const MEMORY_RELEVANT_LIMIT = Number(process.env.MEMORY_RELEVANT_LIMIT || 8);
const MEMORY_ITEM_LIMIT = Number(process.env.MEMORY_ITEM_LIMIT || 120);
const MEMORY_TEMP_TTL_MS = Number(process.env.MEMORY_TEMP_TTL_MS || 3 * 24 * 3600 * 1000);
const MEMORY_TASK_TTL_MS = Number(process.env.MEMORY_TASK_TTL_MS || 14 * 24 * 3600 * 1000);
const MEMORY_DECISION_TTL_MS = Number(process.env.MEMORY_DECISION_TTL_MS || 180 * 24 * 3600 * 1000);
const MEMORY_STALE_MS = Number(process.env.MEMORY_STALE_MS || 120 * 24 * 3600 * 1000);
// 是否把短期记忆（最近 N 轮原文）也落盘。默认 off：短期仅存内存、重启清空。
// 开启后短期原文写入各场景文件的 messages 字段，重启可恢复（受 TTL 约束，过期的不恢复）。
const PERSIST_SHORT = (process.env.MEMORY_PERSIST_SHORT || 'off').toLowerCase() === 'on';

// 持久化根目录：data/memory/（相对本文件，绝对路径）
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.MEMORY_DATA_DIR || join(__dirname, '..', 'data', 'memory');

function nowIso() { return new Date().toISOString(); }
function timeMs(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : 0;
}
function clipText(value, maxChars) {
  const s = String(value || '');
  if (!maxChars || s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 20)) + '\n…（已按上下文预算截断）';
}
function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function stripKeyPrefix(value, key) {
  const s = String(value || '').trim();
  const k = String(key || '').trim();
  if (!k) return s;
  return s.replace(new RegExp(`^(?:${escapeRe(k)}\\s*[:：]\\s*)+`, 'i'), '').trim();
}
function factValueToContent(key, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return stripKeyPrefix(raw, key);
}
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const latin = s.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const chars = cjk.flatMap((part) => {
    const out = [];
    for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
    return out;
  });
  return new Set([...latin, ...chars].filter(Boolean));
}
function inferMemoryType(key, value) {
  const text = `${key} ${value}`.toLowerCase();
  if (/待办|任务|todo|deadline|截止|承诺|答应|跟进|active_task/.test(text)) return 'task';
  if (/偏好|喜欢|习惯|prefer|preference|风格|tone/.test(text)) return 'preference';
  if (/身份|角色|部门|职位|称呼|profile|role|关系/.test(text)) return 'relationship';
  if (/决定|结论|约定|decision|standing_decisions/.test(text)) return 'decision';
  if (/临时|今天|明天|本周|temporary/.test(text)) return 'temporary';
  return 'fact';
}
function defaultExpiresAt(type, base = Date.now()) {
  if (type === 'task') return new Date(base + MEMORY_TASK_TTL_MS).toISOString();
  if (type === 'temporary') return new Date(base + MEMORY_TEMP_TTL_MS).toISOString();
  if (type === 'decision') return new Date(base + MEMORY_DECISION_TTL_MS).toISOString();
  return null;
}
function memoryContent(item) {
  return String(item?.content || item?.value || '').trim();
}
function factsToMemoryItems(facts, { scope = 'session', source = 'llm' } = {}) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return [];
  const createdAt = nowIso();
  return Object.entries(facts)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => {
      const content = factValueToContent(key, value);
      const type = inferMemoryType(key, content);
      return {
        id: randomUUID(),
        scope,
        type,
        source,
        key: String(key),
        content,
        confidence: source === 'legacy' ? 0.65 : 0.75,
        createdAt,
        updatedAt: createdAt,
        expiresAt: defaultExpiresAt(type),
        lastUsedAt: '',
        useCount: 0,
      };
    });
}
function normalizeMemoryItems(rawItems, legacyFacts, { scope = 'session' } = {}) {
  const now = nowIso();
  const items = [];
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const key = String(item.key || '').trim();
    const content = stripKeyPrefix(memoryContent(item), key);
    if (!content) continue;
    const type = item.type || inferMemoryType(key, content);
    items.push({
      id: item.id || randomUUID(),
      scope: item.scope || scope,
      type,
      source: item.source || 'llm',
      key,
      content,
      confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0.7,
      createdAt: item.createdAt || item.updatedAt || now,
      updatedAt: item.updatedAt || item.createdAt || now,
      expiresAt: item.expiresAt === undefined ? defaultExpiresAt(type) : item.expiresAt,
      lastUsedAt: item.lastUsedAt || '',
      useCount: Math.max(0, Number(item.useCount) || 0),
    });
  }
  return pruneMemories(mergeMemories(items, factsToMemoryItems(legacyFacts, { scope, source: 'legacy' })));
}
function mergeMemories(existing, incoming) {
  const byKey = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const itemKey = String(item.key || '').trim();
    const content = stripKeyPrefix(memoryContent(item), itemKey);
    if (!content) continue;
    const type = item.type || inferMemoryType(itemKey, content);
    const mergeKey = itemKey
      ? `${item.scope || ''}|${itemKey.toLowerCase()}`
      : `${item.scope || ''}|${type}|${content.toLowerCase()}`;
    const prev = byKey.get(mergeKey);
    if (prev && item.source === 'legacy' && prev.source !== 'legacy') {
      continue;
    }
    if (!prev || prev.source === 'legacy' || timeMs(item.updatedAt) >= timeMs(prev.updatedAt)) {
      byKey.set(mergeKey, { ...prev, ...item, key: itemKey, type, content });
    }
  }
  return [...byKey.values()];
}
function pruneMemories(items) {
  const now = Date.now();
  return (items || [])
    .filter((item) => {
      const content = memoryContent(item);
      if (!content) return false;
      if (item.expiresAt && timeMs(item.expiresAt) > 0 && timeMs(item.expiresAt) <= now) return false;
      const durable = ['preference', 'relationship'].includes(item.type);
      const last = timeMs(item.lastUsedAt) || timeMs(item.updatedAt) || timeMs(item.createdAt);
      if (!durable && last > 0 && now - last > MEMORY_STALE_MS && (Number(item.useCount) || 0) === 0) return false;
      return true;
    })
    .sort((a, b) => {
      const scoreA = (Number(a.confidence) || 0) + Math.min(0.3, (Number(a.useCount) || 0) * 0.02) + (timeMs(a.updatedAt) / 1e14);
      const scoreB = (Number(b.confidence) || 0) + Math.min(0.3, (Number(b.useCount) || 0) * 0.02) + (timeMs(b.updatedAt) / 1e14);
      return scoreB - scoreA;
    })
    .slice(0, MEMORY_ITEM_LIMIT);
}
function memoryOverlap(item, queryTokens) {
  const textTokens = tokenize(`${item.key || ''} ${item.content || ''} ${item.type || ''}`);
  let overlap = 0;
  for (const t of queryTokens) if (textTokens.has(t)) overlap += 1;
  return overlap;
}
function relevanceScore(item, overlap, fallbackRank) {
  const recency = Math.min(1, Math.max(0, (timeMs(item.updatedAt) || 0) / Date.now()));
  const confidence = Number(item.confidence) || 0;
  const used = Math.min(0.4, (Number(item.useCount) || 0) * 0.04);
  return overlap * 3 + confidence + used + recency * 0.2 - fallbackRank * 0.001;
}
function selectRelevantMemories(items, query, { limit = MEMORY_RELEVANT_LIMIT, budgetChars = 2400 } = {}) {
  const queryTokens = tokenize(query);
  const scored = pruneMemories(items)
    .map((item, idx) => {
      const overlap = memoryOverlap(item, queryTokens);
      return { item, overlap, score: relevanceScore(item, overlap, idx) };
    });
  const hasOverlap = queryTokens.size > 0 && scored.some((x) => x.overlap > 0);
  const ranked = scored
    .filter((x) => !hasOverlap || x.overlap > 0)
    .sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const { item } of ranked) {
    const len = memoryContent(item).length + 80;
    if (out.length >= limit || used + len > budgetChars) break;
    item.lastUsedAt = nowIso();
    item.useCount = (Number(item.useCount) || 0) + 1;
    out.push(item);
    used += len;
  }
  return out;
}
function memoriesToFacts(items) {
  const facts = {};
  for (const item of items || []) {
    const key = item.key || `${item.type || 'memory'}_${Object.keys(facts).length + 1}`;
    facts[key] = stripKeyPrefix(memoryContent(item), key);
  }
  return facts;
}
function formatMemoryBrief(items) {
  return (items || [])
    .map((m) => `- [${m.type || 'fact'}|${m.scope || 'session'}|${m.source || 'unknown'}|${Math.round((Number(m.confidence) || 0) * 100)}%] ${stripKeyPrefix(memoryContent(m), m.key)}`)
    .join('\n');
}
function clipHistory(messages, budgetChars) {
  const out = [];
  let used = 0;
  for (const m of [...(messages || [])].reverse()) {
    const content = String(m.content || '');
    const len = content.length + 32;
    if (used + len > budgetChars && out.length > 0) break;
    out.push({ ...m, content: clipText(content, Math.max(200, budgetChars - used)) });
    used += len;
    if (used >= budgetChars) break;
  }
  return out.reverse();
}

// 内存态：id -> {
//   desc, updatedAt, messages:[{role,content}]（短期）,
//   summary:string（长期）, facts:{}（关键）, evicted:[]（待压缩）, turnsSinceExtract
// }
const store = new Map();
const groupStore = new Map();
const maintenanceQueues = new Map();
const groupMaintenanceQueues = new Map();

// 生成会话描述对象。desc.id 作为内存 key；其余字段用于按用户定位磁盘路径。
export function sessionKey({ chatType, chatId, senderId, senderName = '', senderDept = '', senderEmail = '' }) {
  const scene = chatType === 'group' ? `group_${chatId || 'unknown'}` : 'p2p';
  const id = chatType === 'group' ? `g:${chatId}:${senderId}` : `p:${senderId}`;
  return { id, senderId: senderId || 'unknown', senderName, senderDept, senderEmail, scene, chatType, chatId: chatId || '' };
}

// 把字符串或描述对象统一成描述对象（兼容旧调用）
function toDesc(key) {
  if (key && typeof key === 'object') return key;
  return { id: String(key), senderId: String(key), senderName: '', scene: 'p2p', chatType: 'p2p', chatId: '' };
}

// 用户目录名：<安全用户名>_<openid尾8位>。无名字时用 openid。
function userDirName(desc) {
  const shortId = (desc.senderId || 'unknown').slice(-8);
  const safeName = (desc.senderName || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '').slice(0, 24);
  return safeName ? `${safeName}_${shortId}` : `user_${shortId}`;
}
function userDir(desc) { return join(DATA_DIR, userDirName(desc)); }
function sceneFile(desc) { return join(userDir(desc), `${desc.scene}.json`); }
function profileFile(desc) { return join(userDir(desc), 'profile.json'); }
function safeId(id) { return String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96); }
function groupDir() { return join(DATA_DIR, 'groups'); }
function groupFile(chatId) { return join(groupDir(), `group_${safeId(chatId)}.json`); }

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function ensureUserDir(desc) {
  const dir = userDir(desc);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function ensureGroupDir() {
  const dir = groupDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function persistProfile(desc) {
  try {
    ensureUserDir(desc);
    atomicWriteJson(profileFile(desc), {
      name: desc.senderName || '',
      department: desc.senderDept || '',
      email: desc.senderEmail || '',
      openId: desc.senderId || '',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[memory] profile 落盘失败：', err.message);
  }
}

// 从磁盘加载持久化部分（summary + facts，可选短期 messages）到内存态
function loadPersisted(desc, s) {
  try {
    const f = sceneFile(desc);
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      s.summary = typeof data.summary === 'string' ? data.summary : '';
      s.facts = data.facts && typeof data.facts === 'object' ? data.facts : {};
      s.memories = normalizeMemoryItems(data.memories, s.facts, {
        scope: desc.chatType === 'group' ? 'group_user' : 'p2p',
      });
      // 短期原文恢复：仅当开关开启、磁盘上有 messages，且最近活动未超过 TTL（避免捞回很久以前的对话）。
      if (PERSIST_SHORT && Array.isArray(data.messages) && data.messages.length) {
        const savedAt = data.updatedAt ? Date.parse(data.updatedAt) : 0;
        if (!savedAt || Date.now() - savedAt <= TTL_MS) {
          s.messages = data.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-SHORT_TURNS * 2);
        }
      }
    }
  } catch (err) {
    console.error('[memory] 读取持久化失败：', err.message);
  }
}

// 落盘 summary + facts（按用户目录 + 场景文件）；开关开启时一并落盘短期 messages；同时刷新 profile.json
function persist(desc, s) {
  try {
    ensureUserDir(desc);
    const payload = {
      scene: desc.scene,
      chatType: desc.chatType,
      chatId: desc.chatId,
      summary: s.summary || '',
      facts: s.facts || {},
      memories: pruneMemories(s.memories || []),
      updatedAt: new Date().toISOString(),
    };
    if (PERSIST_SHORT) payload.messages = (s.messages || []).slice(-SHORT_TURNS * 2);
    atomicWriteJson(sceneFile(desc), payload);
    persistProfile(desc);
  } catch (err) {
    console.error('[memory] 落盘失败：', err.message);
  }
}

function loadPersistedGroup(chatId, s) {
  try {
    const f = groupFile(chatId);
    if (!existsSync(f)) return;
    const data = JSON.parse(readFileSync(f, 'utf8'));
    s.summary = typeof data.summary === 'string' ? data.summary : '';
    s.facts = data.facts && typeof data.facts === 'object' ? data.facts : {};
    s.memories = normalizeMemoryItems(data.memories, s.facts, { scope: 'group' });
    if (PERSIST_SHORT && Array.isArray(data.messages) && data.messages.length) {
      const savedAt = data.updatedAt ? Date.parse(data.updatedAt) : 0;
      if (!savedAt || Date.now() - savedAt <= TTL_MS) {
        s.messages = data.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-SHORT_TURNS * 2);
      }
    }
  } catch (err) {
    console.error('[memory] 读取群共享记忆失败：', err.message);
  }
}

function persistGroup(chatId, s) {
  try {
    ensureGroupDir();
    const payload = {
      chatId,
      summary: s.summary || '',
      facts: s.facts || {},
      memories: pruneMemories(s.memories || []),
      updatedAt: new Date().toISOString(),
    };
    if (PERSIST_SHORT) payload.messages = (s.messages || []).slice(-SHORT_TURNS * 2);
    atomicWriteJson(groupFile(chatId), payload);
  } catch (err) {
    console.error('[memory] 群共享记忆落盘失败：', err.message);
  }
}

// 获取（或初始化）会话态。persist=true 时首次尝试从磁盘加载长期/关键记忆。
function getSession(key, { persist: usePersist } = {}) {
  const desc = toDesc(key);
  let s = store.get(desc.id);
  if (s && Date.now() - s.updatedAt > TTL_MS) {
    // 短期过期：清空短期，保留内存里的长期/关键（磁盘也在）
    s.messages = [];
    s.evicted = [];
  }
  if (!s) {
    s = { desc, updatedAt: Date.now(), messages: [], summary: '', facts: {}, memories: [], evicted: [], turnsSinceExtract: 0 };
    if (usePersist) loadPersisted(desc, s);
    s.memories = pruneMemories(s.memories || []);
    s.facts = memoriesToFacts(s.memories.length ? s.memories : factsToMemoryItems(s.facts, {
      scope: desc.chatType === 'group' ? 'group_user' : 'p2p',
      source: 'legacy',
    }));
    store.set(desc.id, s);
    if (store.size > MAX_SESSIONS) {
      let oldestKey = null; let oldest = Infinity;
      for (const [k, v] of store) if (v.updatedAt < oldest) { oldest = v.updatedAt; oldestKey = k; }
      if (oldestKey) store.delete(oldestKey);
    }
  } else {
    // 身份资料可能补全或更新，保持目录描述与最新上下文一致。
    s.desc = { ...s.desc, ...desc };
  }
  return s;
}

function getGroupSession(chatId, { persist: usePersist } = {}) {
  const id = String(chatId || 'unknown');
  let s = groupStore.get(id);
  if (s && Date.now() - s.updatedAt > TTL_MS) {
    s.messages = [];
    s.evicted = [];
  }
  if (!s) {
    s = { chatId: id, updatedAt: Date.now(), messages: [], summary: '', facts: {}, memories: [], evicted: [], turnsSinceExtract: 0 };
    if (usePersist) loadPersistedGroup(id, s);
    s.memories = pruneMemories(s.memories || []);
    s.facts = memoriesToFacts(s.memories.length ? s.memories : factsToMemoryItems(s.facts, { scope: 'group', source: 'legacy' }));
    groupStore.set(id, s);
    if (groupStore.size > MAX_SESSIONS) {
      let oldestKey = null; let oldest = Infinity;
      for (const [k, v] of groupStore) if (v.updatedAt < oldest) { oldest = v.updatedAt; oldestKey = k; }
      if (oldestKey) groupStore.delete(oldestKey);
    }
  }
  return s;
}

// 组装给模型的上下文：按相关性和预算返回精简 history / summary / memories。
export function buildContext(key, { persist: usePersist = false, query = '', budgetChars = CONTEXT_BUDGET_CHARS } = {}) {
  const s = getSession(key, { persist: usePersist });
  const memoryBudget = Math.max(1200, Math.floor(budgetChars * 0.25));
  const historyBudget = Math.max(2400, Math.floor(budgetChars * 0.55));
  const summaryBudget = Math.max(600, Math.floor(budgetChars * 0.12));
  const selected = usePersist
    ? selectRelevantMemories(s.memories || [], query || s.messages.at(-1)?.content || '', { budgetChars: memoryBudget })
    : [];
  return {
    facts: usePersist ? memoriesToFacts(selected) : {},
    memories: selected,
    memoryBrief: formatMemoryBrief(selected),
    summary: usePersist ? clipText(s.summary || '', summaryBudget) : '',
    history: clipHistory(s.messages, historyBudget),
  };
}

export function buildGroupContext(chatId, { persist: usePersist = false, query = '', budgetChars = Math.floor(CONTEXT_BUDGET_CHARS * 0.45) } = {}) {
  const s = getGroupSession(chatId, { persist: usePersist });
  const memoryBudget = Math.max(1000, Math.floor(budgetChars * 0.35));
  const recentBudget = Math.max(1200, Math.floor(budgetChars * 0.45));
  const summaryBudget = Math.max(500, Math.floor(budgetChars * 0.15));
  const selected = usePersist
    ? selectRelevantMemories(s.memories || [], query || s.messages.at(-1)?.content || '', {
      limit: Math.max(4, Math.floor(MEMORY_RELEVANT_LIMIT / 2)),
      budgetChars: memoryBudget,
    })
    : [];
  return {
    groupSummary: usePersist ? clipText(s.summary || '', summaryBudget) : '',
    groupFacts: usePersist ? memoriesToFacts(selected) : {},
    groupMemories: selected,
    groupMemoryBrief: formatMemoryBrief(selected),
    groupRecent: clipHistory(s.messages.slice(-12), recentBudget),
  };
}

// 追加一轮对话。超出短期窗口的旧轮次移入 evicted（待压缩）。
export function appendTurn(key, userText, assistantText, { persist: usePersist = false } = {}) {
  if (!userText || !assistantText) return;
  const s = getSession(key, { persist: usePersist });
  s.messages.push({ role: 'user', content: userText });
  s.messages.push({ role: 'assistant', content: assistantText });
  s.turnsSinceExtract += 1;
  const maxMsgs = SHORT_TURNS * 2;
  if (s.messages.length > maxMsgs) {
    const overflow = s.messages.splice(0, s.messages.length - maxMsgs);
    if (usePersist) s.evicted.push(...overflow); // 只有持久化会话才压缩长期记忆
  }
  s.updatedAt = Date.now();
  if (usePersist) {
    // 开启短期落盘时，每轮都把短期原文写盘，确保重启不丢最近对话；
    // 否则仅刷新 profile（summary/facts 仍由 maintainMemory 择机落盘）。
    if (PERSIST_SHORT) persist(s.desc, s);
    else persistProfile(s.desc);
  }
}

export function appendGroupTurn(chatId, { senderName = '', userText = '', assistantText = '', threadContext = '' } = {}, { persist: usePersist = false } = {}) {
  if (!chatId || (!userText && !assistantText && !threadContext)) return;
  const s = getGroupSession(chatId, { persist: usePersist });
  if (threadContext) {
    s.messages.push({
      role: 'user',
      content: `【群聊上文】\n${String(threadContext).slice(0, 4000)}`,
    });
  }
  if (userText) {
    s.messages.push({
      role: 'user',
      content: `${senderName || '某人'}：${userText}`,
    });
  }
  if (assistantText) {
    s.messages.push({
      role: 'assistant',
      content: `助理：${assistantText}`,
    });
  }
  s.turnsSinceExtract += 1;
  const maxMsgs = SHORT_TURNS * 2;
  if (s.messages.length > maxMsgs) {
    const overflow = s.messages.splice(0, s.messages.length - maxMsgs);
    if (usePersist) s.evicted.push(...overflow);
  }
  s.updatedAt = Date.now();
  if (usePersist && PERSIST_SHORT) persistGroup(s.chatId, s);
}

async function doMaintainMemory(key) {
  const desc = toDesc(key);
  const s = store.get(desc.id);
  if (!s) return;
  let changed = false;

  // 1) 长期摘要：有旧轮滑出窗口 → 增量压缩
  if (s.evicted.length > 0) {
    const toCompress = s.evicted;
    s.evicted = [];
    s.summary = await updateSummary(s.summary, toCompress);
    changed = true;
  }
  // 2) 关键记忆：每满 EXTRACT_EVERY 轮 → 从最近窗口抽取合并
  if (s.turnsSinceExtract >= EXTRACT_EVERY && s.messages.length > 0) {
    s.turnsSinceExtract = 0;
    const snapshot = s.messages.slice();
    const extracted = await extractKeyMemory(s.facts, snapshot);
    const scope = desc.chatType === 'group' ? 'group_user' : 'p2p';
    s.memories = mergeMemories(s.memories || [], factsToMemoryItems(extracted, { scope, source: 'llm' }));
    changed = true;
  }
  const before = (s.memories || []).length;
  s.memories = pruneMemories(s.memories || []);
  s.facts = memoriesToFacts(s.memories);
  if (s.memories.length !== before) changed = true;
  if (changed) persist(s.desc, s);
}

async function doMaintainGroupMemory(chatId) {
  const s = groupStore.get(String(chatId || 'unknown'));
  if (!s) return;
  let changed = false;

  if (s.evicted.length > 0) {
    const toCompress = s.evicted;
    s.evicted = [];
    s.summary = await updateGroupSummary(s.summary, toCompress);
    changed = true;
  }
  if (s.turnsSinceExtract >= EXTRACT_EVERY && s.messages.length > 0) {
    s.turnsSinceExtract = 0;
    const snapshot = s.messages.slice(-Math.min(s.messages.length, SHORT_TURNS * 2));
    s.summary = await updateGroupSummary(s.summary, snapshot);
    const extracted = await extractGroupKeyMemory(s.facts, snapshot);
    s.memories = mergeMemories(s.memories || [], factsToMemoryItems(extracted, { scope: 'group', source: 'llm' }));
    changed = true;
  }
  const before = (s.memories || []).length;
  s.memories = pruneMemories(s.memories || []);
  s.facts = memoriesToFacts(s.memories);
  if (s.memories.length !== before) changed = true;
  if (changed) persistGroup(s.chatId, s);
}

// 同一 session 的维护任务串行执行，避免多个异步摘要/事实抽取相互覆盖。
export function maintainMemory(key) {
  const desc = toDesc(key);
  const previous = maintenanceQueues.get(desc.id) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => doMaintainMemory(desc));
  maintenanceQueues.set(desc.id, next);
  return next.finally(() => {
    if (maintenanceQueues.get(desc.id) === next) maintenanceQueues.delete(desc.id);
  });
}

export function maintainGroupMemory(chatId) {
  const id = String(chatId || 'unknown');
  const previous = groupMaintenanceQueues.get(id) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => doMaintainGroupMemory(id));
  groupMaintenanceQueues.set(id, next);
  return next.finally(() => {
    if (groupMaintenanceQueues.get(id) === next) groupMaintenanceQueues.delete(id);
  });
}

export async function flushMemory() {
  await Promise.allSettled([...maintenanceQueues.values(), ...groupMaintenanceQueues.values()]);
}

// 清空某会话（内存；磁盘文件保留）
export function clearSession(key) {
  store.delete(toDesc(key).id);
}

export function clearGroupSession(chatId) {
  groupStore.delete(String(chatId || 'unknown'));
}

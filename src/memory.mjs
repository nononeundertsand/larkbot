// 三层对话记忆（按用户维度存储）+ 群共享记忆
//
//   1) 短期记忆：滑动窗口，最近 SHORT_TURNS 轮原文，存内存（重启清空）
//   2) 长期记忆：被挤出窗口的旧对话，用 LLM 压缩成滚动摘要，落盘持久化
//   3) 关键记忆：结构化事实 JSON（姓名/偏好/项目/待办…），落盘持久化，关键信息不遗忘
//   4) 轻量知识图谱：本地 JSON 三元组边，表达实体关系，按查询做子图召回
//
//   持久化布局（按用户分目录，方便人工查看/调整）：
//   data/memory/<用户名_openid短码>/
//     ├── profile.json          用户身份 {name, department, email, openId}
//     ├── p2p.json              私聊场景 {summary, facts, memories, graph, updatedAt}
//     └── group_<chatId>.json   各群场景 {summary, facts, memories, graph, updatedAt}
//   data/memory/groups/
//     └── group_<chatId>.json   群共享记忆 {summary, facts, memories, graph, updatedAt}
//   同一用户的所有会话集中在其目录内；短期原文不落盘。
//
// 维护时机（省成本）：回复后异步调用 maintainMemory()：
//   - 有旧轮次滑出窗口时 → 增量更新长期摘要
//   - 每满 EXTRACT_EVERY 轮 → 抽取/合并关键记忆与关系边

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { updateSummary, extractKeyMemory, updateGroupSummary, extractGroupKeyMemory, currentDefaultModelId } from './reply.mjs';

const SHORT_TURNS = Number(process.env.MEMORY_SHORT_TURNS || 30); // 短期滑动窗口轮数
const TTL_MS = Number(process.env.MEMORY_TTL_MS || 30 * 60 * 1000); // 短期无活动过期
const MAX_SESSIONS = Number(process.env.MEMORY_MAX_SESSIONS || 1000);
const EXTRACT_EVERY = Number(process.env.MEMORY_EXTRACT_EVERY || 5); // 每几轮抽取一次关键记忆
const CONTEXT_BUDGET_CHARS = Number(process.env.MEMORY_CONTEXT_BUDGET_CHARS || 12000);
const MEMORY_RELEVANT_LIMIT = Number(process.env.MEMORY_RELEVANT_LIMIT || 8);
const MEMORY_ITEM_LIMIT = Number(process.env.MEMORY_ITEM_LIMIT || 120);
const MEMORY_GRAPH_EDGE_LIMIT = Number(process.env.MEMORY_GRAPH_EDGE_LIMIT || 240);
const MEMORY_GRAPH_RELEVANT_LIMIT = Number(process.env.MEMORY_GRAPH_RELEVANT_LIMIT || Math.max(8, MEMORY_RELEVANT_LIMIT));
const MEMORY_GRAPH_HOPS = Math.max(0, Number(process.env.MEMORY_GRAPH_HOPS || 2));
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
function sourceTextHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value || '')).digest('hex');
}
function makeProvenance({ sourceSessionId = '', snapshot = [], evidence = '' } = {}) {
  const text = evidence || (snapshot || []).map((m) => `${m.role || ''}:${m.content || ''}`).join('\n');
  return {
    sourceSessionId,
    sourceMessageIds: (snapshot || []).map((m) => m.messageId || m.id || '').filter(Boolean),
    sourceTextHash: text ? sourceTextHash(text) : '',
    extractedAt: nowIso(),
    extractorModel: currentDefaultModelId(),
    evidence: String(evidence || '').slice(0, 500),
  };
}
function hasSecurityContext(key) {
  return /安全|攻击|注入|越权|风险|防护|红队|拦截/.test(String(key || ''));
}
function memoryWritePolicy(key, content, { source = 'llm' } = {}) {
  if (source !== 'llm') return { status: 'active', policyReason: '' };
  const text = `${key || ''} ${content || ''}`;
  if (/(authorization\s*:\s*bearer|api[-_ ]?key|access[-_]?key|refresh[-_]?token|bearer[-_ ]?token|password|credential|private\s+key|\.env|密钥|密码|凭证|私钥|令牌)/i.test(text)) {
    return { status: 'quarantined', policyReason: '疑似凭证或敏感配置，不进入主动召回' };
  }
  if (/(我是|我才是|把我|记住我|以后我).{0,12}(主人|owner|管理员|root)/i.test(text)) {
    return { status: 'quarantined', policyReason: '疑似身份/权限篡改记忆' };
  }
  if (!hasSecurityContext(key) && /(忽略(上面|之前|以上|前面).{0,8}(指令|规则|提示|设定)|system prompt|系统提示词|developer mode|jailbreak|越狱|DAN模式)/i.test(text)) {
    return { status: 'quarantined', policyReason: '疑似提示词注入内容' };
  }
  return { status: 'active', policyReason: '' };
}
function memoryIsActive(item) {
  return (item?.status || 'active') === 'active';
}
function factsToMemoryItems(facts, { scope = 'session', source = 'llm', provenance = {} } = {}) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return [];
  const createdAt = nowIso();
  return Object.entries(facts)
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => {
      const content = factValueToContent(key, value);
      const type = inferMemoryType(key, content);
      const policy = memoryWritePolicy(key, content, { source });
      return {
        id: randomUUID(),
        scope,
        type,
        source,
        key: String(key),
        content,
        confidence: source === 'legacy' ? 0.65 : 0.75,
        status: policy.status,
        policyReason: policy.policyReason,
        sourceSessionId: provenance.sourceSessionId || '',
        sourceMessageIds: provenance.sourceMessageIds || [],
        sourceTextHash: provenance.sourceTextHash || '',
        extractedAt: provenance.extractedAt || (source === 'llm' ? createdAt : ''),
        extractorModel: provenance.extractorModel || '',
        evidence: provenance.evidence || '',
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
      status: item.status || 'active',
      policyReason: item.policyReason || '',
      conflictWith: Array.isArray(item.conflictWith) ? item.conflictWith : [],
      conflictReason: item.conflictReason || '',
      supersededBy: item.supersededBy || '',
      sourceSessionId: item.sourceSessionId || '',
      sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds : [],
      sourceTextHash: item.sourceTextHash || '',
      extractedAt: item.extractedAt || '',
      extractorModel: item.extractorModel || '',
      evidence: item.evidence || '',
      createdAt: item.createdAt || item.updatedAt || now,
      updatedAt: item.updatedAt || item.createdAt || now,
      expiresAt: item.expiresAt === undefined ? defaultExpiresAt(type) : item.expiresAt,
      lastUsedAt: item.lastUsedAt || '',
      useCount: Math.max(0, Number(item.useCount) || 0),
    });
  }
  return pruneMemories(mergeMemories(items, factsToMemoryItems(legacyFacts, { scope, source: 'legacy' })));
}

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseJsonLike(value) {
  const text = String(value || '').trim();
  if (!/^[\[{]/.test(text)) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function isSubsetValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.every((item) => b.some((cand) => isSubsetValue(item, cand)));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return Object.entries(a).every(([key, value]) => key in b && isSubsetValue(value, b[key]));
  }
  return false;
}

function memoryCanSupersede(oldItem, newItem) {
  if (!oldItem || !newItem) return false;
  if (!memoryIsActive(oldItem) || !memoryIsActive(newItem)) return false;
  const oldJson = parseJsonLike(memoryContent(oldItem));
  const newJson = parseJsonLike(memoryContent(newItem));
  if (oldJson && newJson && isSubsetValue(oldJson, newJson)) return true;
  const oldText = comparableText(memoryContent(oldItem));
  const newText = comparableText(memoryContent(newItem));
  return oldText && newText && oldText !== newText && newText.includes(oldText);
}

function withSuperseded(item, supersededBy, reason = '被更新记忆取代') {
  return {
    ...item,
    status: item.status === 'quarantined' ? item.status : 'superseded',
    supersededBy,
    conflictReason: item.conflictReason || reason,
    updatedAt: item.updatedAt || nowIso(),
  };
}

function withConflict(item, conflictWith, reason = '同 key 存在多个不同值') {
  return {
    ...item,
    status: item.status === 'quarantined' ? item.status : 'conflicted',
    conflictWith: [...new Set([...(Array.isArray(item.conflictWith) ? item.conflictWith : []), ...conflictWith].filter(Boolean))],
    conflictReason: item.conflictReason || reason,
    updatedAt: item.updatedAt || nowIso(),
  };
}

function mergeMemories(existing, incoming) {
  const groups = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const itemKey = String(item.key || '').trim();
    const content = stripKeyPrefix(memoryContent(item), itemKey);
    if (!content) continue;
    const type = item.type || inferMemoryType(itemKey, content);
    const mergeKey = itemKey
      ? `${item.scope || ''}|${itemKey.toLowerCase()}`
      : `${item.scope || ''}|${type}|${content.toLowerCase()}`;
    const normalized = { ...item, key: itemKey, type, content };
    const bucket = groups.get(mergeKey) || [];
    const sameContent = bucket.find((prev) => comparableText(memoryContent(prev)) === comparableText(content));
    if (sameContent) {
      const merged = timeMs(normalized.updatedAt) >= timeMs(sameContent.updatedAt)
        ? { ...sameContent, ...normalized }
        : { ...normalized, ...sameContent };
      merged.useCount = Math.max(Number(sameContent.useCount) || 0, Number(normalized.useCount) || 0);
      merged.lastUsedAt = normalized.lastUsedAt || sameContent.lastUsedAt || '';
      bucket.splice(bucket.indexOf(sameContent), 1, merged);
    } else {
      bucket.push(normalized);
    }
    groups.set(mergeKey, bucket);
  }

  const out = [];
  for (const bucket of groups.values()) {
    const nonLegacy = bucket.filter((item) => item.source !== 'legacy');
    let items = nonLegacy.length ? [
      ...nonLegacy,
      ...bucket.filter((item) => item.source === 'legacy').map((item) => withSuperseded(item, nonLegacy[0]?.id || '', '旧 facts 已被结构化 memory 取代')),
    ] : bucket;
    const active = items.filter(memoryIsActive);
    if (active.length > 1) {
      const sorted = [...active].sort((a, b) => timeMs(b.updatedAt) - timeMs(a.updatedAt));
      const latest = sorted[0];
      const canSupersedeAll = sorted.slice(1).every((item) => memoryCanSupersede(item, latest));
      if (canSupersedeAll) {
        items = items.map((item) => item === latest || !memoryIsActive(item) ? item : withSuperseded(item, latest.id, '新记忆包含旧记忆内容'));
      } else {
        const activeIds = active.map((item) => item.id).filter(Boolean);
        items = items.map((item) => memoryIsActive(item)
          ? withConflict(item, activeIds.filter((id) => id !== item.id))
          : item);
      }
    }
    out.push(...items);
  }
  return out;
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
    .filter(memoryIsActive)
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
    if (!memoryIsActive(item)) continue;
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
function clampConfidence(value, fallback = 0.75) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function entityLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function graphEntityKey(value) {
  return entityLabel(value).toLowerCase().replace(/\s+/g, '');
}
function graphPredicate(value) {
  return entityLabel(value).slice(0, 48);
}
function graphEdgeText(edge) {
  return `${edge.subject || ''} ${edge.predicate || ''} ${edge.object || ''} ${edge.description || ''}`.trim();
}
function graphEdgeKey(edge) {
  return [
    edge.scope || '',
    graphEntityKey(edge.subject),
    String(edge.predicate || '').toLowerCase(),
    graphEntityKey(edge.object),
  ].join('|');
}
function graphEdgeIsActive(edge) {
  return (edge?.status || 'active') === 'active';
}
function isAliasPredicate(predicate) {
  return /别名|别称|昵称|alias|称呼规则/i.test(String(predicate || ''));
}
function rawGraphEdges(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.edges)) return raw.edges;
  if (Array.isArray(raw.relations)) return raw.relations;
  if (Array.isArray(raw.graphEdges)) return raw.graphEdges;
  if (Array.isArray(raw.graph_edges)) return raw.graph_edges;
  if (raw.graph && typeof raw.graph === 'object') return rawGraphEdges(raw.graph);
  return [];
}
function normalizeGraphEdges(rawEdges, { scope = 'session', origin = 'llm', provenance = {} } = {}) {
  const now = nowIso();
  const edges = [];
  for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!raw || typeof raw !== 'object') continue;
    const subject = entityLabel(raw.subject ?? raw.source ?? raw.from ?? raw.head);
    const predicate = graphPredicate(raw.predicate ?? raw.relation ?? raw.rel ?? raw.type);
    const object = entityLabel(raw.object ?? raw.target ?? raw.to ?? raw.tail);
    if (!subject || !predicate || !object) continue;
    const relationType = inferMemoryType(predicate, `${subject} ${object} ${raw.description || raw.note || ''}`);
    const policy = memoryWritePolicy(predicate, `${subject} ${object} ${raw.description || raw.note || ''}`, { source: origin });
    edges.push({
      id: raw.id || randomUUID(),
      scope: raw.scope || scope,
      subject,
      predicate,
      object,
      description: String(raw.description || raw.note || '').trim(),
      confidence: clampConfidence(raw.confidence, origin === 'legacy' ? 0.65 : 0.75),
      origin: raw.origin || raw.memorySource || origin,
      status: raw.status || policy.status,
      policyReason: raw.policyReason || policy.policyReason,
      conflictWith: Array.isArray(raw.conflictWith) ? raw.conflictWith : [],
      conflictReason: raw.conflictReason || '',
      supersededBy: raw.supersededBy || '',
      sourceSessionId: raw.sourceSessionId || provenance.sourceSessionId || '',
      sourceMessageIds: Array.isArray(raw.sourceMessageIds) ? raw.sourceMessageIds : provenance.sourceMessageIds || [],
      sourceTextHash: raw.sourceTextHash || provenance.sourceTextHash || '',
      extractedAt: raw.extractedAt || provenance.extractedAt || (origin === 'llm' ? now : ''),
      extractorModel: raw.extractorModel || provenance.extractorModel || '',
      evidence: raw.evidence || provenance.evidence || '',
      createdAt: raw.createdAt || raw.updatedAt || now,
      updatedAt: raw.updatedAt || raw.createdAt || now,
      expiresAt: raw.expiresAt === undefined ? defaultExpiresAt(relationType) : raw.expiresAt,
      lastUsedAt: raw.lastUsedAt || '',
      useCount: Math.max(0, Number(raw.useCount) || 0),
    });
  }
  return edges;
}
function mergeGraphEdges(existing, incoming) {
  const byKey = new Map();
  for (const edge of [...(existing || []), ...(incoming || [])]) {
    if (!edge?.subject || !edge?.predicate || !edge?.object) continue;
    const key = graphEdgeKey(edge);
    const prev = byKey.get(key);
    if (prev && edge.origin === 'legacy' && prev.origin !== 'legacy') continue;
    if (prev && graphEdgeIsActive(prev) && !graphEdgeIsActive(edge)) continue;
    if (!prev || prev.origin === 'legacy' || timeMs(edge.updatedAt) >= timeMs(prev.updatedAt)) {
      byKey.set(key, {
        ...prev,
        ...edge,
        id: prev?.id || edge.id || randomUUID(),
        useCount: Math.max(Number(prev?.useCount) || 0, Number(edge.useCount) || 0),
        lastUsedAt: edge.lastUsedAt || prev?.lastUsedAt || '',
      });
    }
  }
  return applyGraphConflicts([...byKey.values()]);
}
function graphConflictGroupKey(edge) {
  return [
    edge.scope || '',
    graphEntityKey(edge.subject),
    String(edge.predicate || '').toLowerCase(),
  ].join('|');
}
function edgeWithConflict(edge, conflictWith, reason = '同 subject/predicate 存在多个不同 object') {
  return {
    ...edge,
    status: edge.status === 'quarantined' ? edge.status : 'conflicted',
    conflictWith: [...new Set([...(Array.isArray(edge.conflictWith) ? edge.conflictWith : []), ...conflictWith].filter(Boolean))],
    conflictReason: edge.conflictReason || reason,
    updatedAt: edge.updatedAt || nowIso(),
  };
}
function applyGraphConflicts(edges) {
  const groups = new Map();
  for (const edge of edges || []) {
    if (!graphEdgeIsActive(edge) || isAliasPredicate(edge.predicate)) continue;
    const key = graphConflictGroupKey(edge);
    const bucket = groups.get(key) || [];
    bucket.push(edge);
    groups.set(key, bucket);
  }
  const conflictedIds = new Map();
  for (const bucket of groups.values()) {
    const objects = new Set(bucket.map((edge) => graphEntityKey(edge.object)).filter(Boolean));
    if (objects.size <= 1) continue;
    const ids = bucket.map((edge) => edge.id).filter(Boolean);
    for (const edge of bucket) {
      conflictedIds.set(edge.id, ids.filter((id) => id !== edge.id));
    }
  }
  if (conflictedIds.size === 0) return edges;
  return (edges || []).map((edge) => conflictedIds.has(edge.id)
    ? edgeWithConflict(edge, conflictedIds.get(edge.id))
    : edge);
}
function graphAliasesFromEdges(edges) {
  const aliases = [];
  const seen = new Set();
  for (const edge of edges || []) {
    if (!graphEdgeIsActive(edge) || !isAliasPredicate(edge.predicate)) continue;
    const canonical = entityLabel(edge.subject);
    const alias = entityLabel(edge.object);
    if (!canonical || !alias || graphEntityKey(canonical) === graphEntityKey(alias)) continue;
    const key = `${edge.scope || ''}|${graphEntityKey(canonical)}|${graphEntityKey(alias)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push({
      scope: edge.scope || 'session',
      canonical,
      alias,
      confidence: Number(edge.confidence) || 0.7,
      sourceEdgeId: edge.id || '',
      updatedAt: edge.updatedAt || '',
    });
  }
  return aliases;
}
function pruneGraphEdges(edges) {
  const now = Date.now();
  return (edges || [])
    .filter((edge) => {
      if (!edge?.subject || !edge?.predicate || !edge?.object) return false;
      if (edge.expiresAt && timeMs(edge.expiresAt) > 0 && timeMs(edge.expiresAt) <= now) return false;
      const relationType = inferMemoryType(edge.predicate, graphEdgeText(edge));
      const durable = ['fact', 'preference', 'relationship', 'decision'].includes(relationType);
      const last = timeMs(edge.lastUsedAt) || timeMs(edge.updatedAt) || timeMs(edge.createdAt);
      if (!durable && last > 0 && now - last > MEMORY_STALE_MS && (Number(edge.useCount) || 0) === 0) return false;
      return true;
    })
    .sort((a, b) => {
      const scoreA = (Number(a.confidence) || 0) + Math.min(0.3, (Number(a.useCount) || 0) * 0.02) + (timeMs(a.updatedAt) / 1e14);
      const scoreB = (Number(b.confidence) || 0) + Math.min(0.3, (Number(b.useCount) || 0) * 0.02) + (timeMs(b.updatedAt) / 1e14);
      return scoreB - scoreA;
    })
    .slice(0, MEMORY_GRAPH_EDGE_LIMIT);
}
function normalizeGraph(raw, { scope = 'session', origin = 'legacy' } = {}) {
  return { edges: pruneGraphEdges(mergeGraphEdges([], normalizeGraphEdges(rawGraphEdges(raw), { scope, origin }))) };
}
function graphNodesFromEdges(edges) {
  const byKey = new Map();
  for (const edge of edges || []) {
    for (const label of [edge.subject, edge.object]) {
      const key = graphEntityKey(label);
      if (!key) continue;
      const prev = byKey.get(key);
      byKey.set(key, {
        id: prev?.id || key,
        label: prev?.label || label,
        scope: edge.scope || prev?.scope || 'session',
        degree: (prev?.degree || 0) + 1,
        confidence: Math.max(Number(prev?.confidence) || 0, Number(edge.confidence) || 0),
        updatedAt: timeMs(edge.updatedAt) >= timeMs(prev?.updatedAt) ? edge.updatedAt : prev?.updatedAt || edge.updatedAt,
        lastUsedAt: timeMs(edge.lastUsedAt) >= timeMs(prev?.lastUsedAt) ? edge.lastUsedAt : prev?.lastUsedAt || '',
        useCount: (Number(prev?.useCount) || 0) + (Number(edge.useCount) || 0),
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.degree - a.degree || timeMs(b.updatedAt) - timeMs(a.updatedAt))
    .slice(0, MEMORY_GRAPH_EDGE_LIMIT * 2);
}
function graphToPersist(graph) {
  const edges = pruneGraphEdges(graph?.edges || []);
  return { nodes: graphNodesFromEdges(edges), aliases: graphAliasesFromEdges(edges), edges };
}
function graphForPrompt(graph) {
  const edges = pruneGraphEdges(graph?.edges || [])
    .filter(graphEdgeIsActive)
    .slice(0, 40)
    .map(({ subject, predicate, object, description, confidence }) => ({
      subject,
      predicate,
      object,
      description,
      confidence,
    }));
  return { edges };
}
function splitExtractedKnowledge(raw, { scope = 'session', provenance = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { facts: {}, edges: [] };
  const graphKeys = new Set(['relations', 'edges', 'graph', 'graphEdges', 'graph_edges', 'nodes']);
  const facts = raw.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts)
    ? raw.facts
    : {};
  if (!raw.facts || typeof raw.facts !== 'object' || Array.isArray(raw.facts)) {
    for (const [key, value] of Object.entries(raw)) {
      if (graphKeys.has(key) || value == null) continue;
      facts[key] = value;
    }
  }
  return {
    facts,
    edges: normalizeGraphEdges(rawGraphEdges(raw), { scope, origin: 'llm', provenance }),
  };
}
function expandGraphQueryWithAliases(query, edges) {
  const expanded = [String(query || '')];
  const rawQuery = String(query || '');
  for (const edge of edges || []) {
    if (!graphEdgeIsActive(edge) || !isAliasPredicate(edge.predicate)) continue;
    const subject = entityLabel(edge.subject);
    const object = entityLabel(edge.object);
    if (!subject || !object) continue;
    if (rawQuery.includes(subject)) expanded.push(object);
    if (rawQuery.includes(object)) expanded.push(subject);
  }
  return expanded.join(' ');
}
function graphOverlap(edge, queryTokens) {
  const textTokens = tokenize(graphEdgeText(edge));
  let overlap = 0;
  for (const t of queryTokens) if (textTokens.has(t)) overlap += 1;
  return overlap;
}
function graphEndpointKeys(edge) {
  return [graphEntityKey(edge.subject), graphEntityKey(edge.object)].filter(Boolean);
}
function selectRelevantGraphEdges(edges, query, { limit = MEMORY_GRAPH_RELEVANT_LIMIT, budgetChars = 2000, hops = MEMORY_GRAPH_HOPS } = {}) {
  const activeEdges = pruneGraphEdges(edges).filter(graphEdgeIsActive);
  const queryTokens = tokenize(expandGraphQueryWithAliases(query, activeEdges));
  const scored = activeEdges
    .map((edge, idx) => {
      const overlap = graphOverlap(edge, queryTokens);
      return { edge, overlap, score: relevanceScore(edge, overlap, idx) };
    });
  const hasOverlap = queryTokens.size > 0 && scored.some((x) => x.overlap > 0);
  const direct = scored
    .filter((x) => !hasOverlap || x.overlap > 0)
    .sort((a, b) => b.score - a.score);
  const selected = [];
  const selectedKeys = new Set();
  let used = 0;
  const add = (edge) => {
    const key = graphEdgeKey(edge);
    if (selectedKeys.has(key)) return false;
    const len = graphEdgeText(edge).length + 96;
    if (selected.length >= limit || used + len > budgetChars) return false;
    edge.lastUsedAt = nowIso();
    edge.useCount = (Number(edge.useCount) || 0) + 1;
    selected.push(edge);
    selectedKeys.add(key);
    used += len;
    return true;
  };

  let frontier = new Set();
  for (const { edge } of direct) {
    if (!add(edge)) break;
    for (const key of graphEndpointKeys(edge)) frontier.add(key);
  }
  for (let hop = 0; hop < hops && frontier.size > 0 && selected.length < limit; hop++) {
    const nextFrontier = new Set();
    const connected = scored
      .filter(({ edge }) => !selectedKeys.has(graphEdgeKey(edge)) && graphEndpointKeys(edge).some((key) => frontier.has(key)))
      .sort((a, b) => b.score - a.score);
    for (const { edge } of connected) {
      if (!add(edge)) break;
      for (const key of graphEndpointKeys(edge)) nextFrontier.add(key);
    }
    frontier = nextFrontier;
  }
  return selected;
}
function formatGraphBrief(edges) {
  return (edges || [])
    .map((edge) => {
      const desc = edge.description ? `（${edge.description}）` : '';
      return `- [relation|${edge.scope || 'session'}|${edge.origin || 'unknown'}|${Math.round((Number(edge.confidence) || 0) * 100)}%] ${edge.subject} --${edge.predicate}--> ${edge.object}${desc}`;
    })
    .join('\n');
}
function formatKnowledgeBrief(items, edges) {
  return [formatMemoryBrief(items), formatGraphBrief(edges)].filter(Boolean).join('\n');
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
//   summary:string（长期）, facts:{}（关键）, graph:{edges:[]}（关系图谱）,
//   evicted:[]（待压缩）, turnsSinceExtract
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
      s.graph = normalizeGraph(data.graph || data.graphEdges || data.graph_edges, {
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
    const graph = graphToPersist(s.graph);
    if (graph.edges.length) payload.graph = graph;
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
    s.graph = normalizeGraph(data.graph || data.graphEdges || data.graph_edges, { scope: 'group' });
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
    const graph = graphToPersist(s.graph);
    if (graph.edges.length) payload.graph = graph;
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
    s = { desc, updatedAt: Date.now(), messages: [], summary: '', facts: {}, memories: [], graph: { edges: [] }, evicted: [], turnsSinceExtract: 0 };
    if (usePersist) loadPersisted(desc, s);
    s.memories = pruneMemories(s.memories || []);
    s.graph = normalizeGraph(s.graph, { scope: desc.chatType === 'group' ? 'group_user' : 'p2p' });
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
    if (!s.graph) s.graph = { edges: [] };
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
    s = { chatId: id, updatedAt: Date.now(), messages: [], summary: '', facts: {}, memories: [], graph: { edges: [] }, evicted: [], turnsSinceExtract: 0 };
    if (usePersist) loadPersistedGroup(id, s);
    s.memories = pruneMemories(s.memories || []);
    s.graph = normalizeGraph(s.graph, { scope: 'group' });
    s.facts = memoriesToFacts(s.memories.length ? s.memories : factsToMemoryItems(s.facts, { scope: 'group', source: 'legacy' }));
    groupStore.set(id, s);
    if (groupStore.size > MAX_SESSIONS) {
      let oldestKey = null; let oldest = Infinity;
      for (const [k, v] of groupStore) if (v.updatedAt < oldest) { oldest = v.updatedAt; oldestKey = k; }
      if (oldestKey) groupStore.delete(oldestKey);
    }
  } else if (!s.graph) {
    s.graph = { edges: [] };
  }
  return s;
}

// 组装给模型的上下文：按相关性和预算返回精简 history / summary / memories。
export function buildContext(key, { persist: usePersist = false, query = '', budgetChars = CONTEXT_BUDGET_CHARS } = {}) {
  const s = getSession(key, { persist: usePersist });
  const memoryBudget = Math.max(1200, Math.floor(budgetChars * 0.25));
  const graphBudget = Math.max(500, Math.floor(memoryBudget * 0.45));
  const factBudget = Math.max(500, memoryBudget - graphBudget);
  const historyBudget = Math.max(2400, Math.floor(budgetChars * 0.55));
  const summaryBudget = Math.max(600, Math.floor(budgetChars * 0.12));
  const q = query || s.messages.at(-1)?.content || '';
  const selected = usePersist
    ? selectRelevantMemories(s.memories || [], q, { budgetChars: factBudget })
    : [];
  const selectedGraph = usePersist
    ? selectRelevantGraphEdges(s.graph?.edges || [], q, { budgetChars: graphBudget })
    : [];
  const graphBrief = formatGraphBrief(selectedGraph);
  return {
    facts: usePersist ? memoriesToFacts(selected) : {},
    memories: selected,
    graphEdges: selectedGraph,
    graphBrief,
    memoryBrief: formatKnowledgeBrief(selected, selectedGraph),
    summary: usePersist ? clipText(s.summary || '', summaryBudget) : '',
    history: clipHistory(s.messages, historyBudget),
  };
}

export function buildGroupContext(chatId, { persist: usePersist = false, query = '', budgetChars = Math.floor(CONTEXT_BUDGET_CHARS * 0.45) } = {}) {
  const s = getGroupSession(chatId, { persist: usePersist });
  const memoryBudget = Math.max(1000, Math.floor(budgetChars * 0.35));
  const graphBudget = Math.max(450, Math.floor(memoryBudget * 0.45));
  const factBudget = Math.max(450, memoryBudget - graphBudget);
  const recentBudget = Math.max(1200, Math.floor(budgetChars * 0.45));
  const summaryBudget = Math.max(500, Math.floor(budgetChars * 0.15));
  const q = query || s.messages.at(-1)?.content || '';
  const selected = usePersist
    ? selectRelevantMemories(s.memories || [], q, {
      limit: Math.max(4, Math.floor(MEMORY_RELEVANT_LIMIT / 2)),
      budgetChars: factBudget,
    })
    : [];
  const selectedGraph = usePersist
    ? selectRelevantGraphEdges(s.graph?.edges || [], q, {
      limit: Math.max(4, Math.floor(MEMORY_GRAPH_RELEVANT_LIMIT / 2)),
      budgetChars: graphBudget,
    })
    : [];
  const graphBrief = formatGraphBrief(selectedGraph);
  return {
    groupSummary: usePersist ? clipText(s.summary || '', summaryBudget) : '',
    groupFacts: usePersist ? memoriesToFacts(selected) : {},
    groupMemories: selected,
    groupGraphEdges: selectedGraph,
    groupGraphBrief: graphBrief,
    groupMemoryBrief: formatKnowledgeBrief(selected, selectedGraph),
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
    const scope = desc.chatType === 'group' ? 'group_user' : 'p2p';
    const provenance = makeProvenance({ sourceSessionId: desc.id, snapshot });
    const extracted = await extractKeyMemory(s.facts, snapshot, graphForPrompt(s.graph));
    const { facts, edges } = splitExtractedKnowledge(extracted, { scope, provenance });
    s.memories = mergeMemories(s.memories || [], factsToMemoryItems(facts, { scope, source: 'llm', provenance }));
    s.graph = { edges: mergeGraphEdges(s.graph?.edges || [], edges) };
    changed = true;
  }
  const before = (s.memories || []).length;
  const beforeGraph = (s.graph?.edges || []).length;
  s.memories = pruneMemories(s.memories || []);
  s.graph = graphToPersist(s.graph);
  s.facts = memoriesToFacts(s.memories);
  if (s.memories.length !== before) changed = true;
  if ((s.graph?.edges || []).length !== beforeGraph) changed = true;
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
    const provenance = makeProvenance({ sourceSessionId: `group:${s.chatId}`, snapshot });
    const extracted = await extractGroupKeyMemory(s.facts, snapshot, graphForPrompt(s.graph));
    const { facts, edges } = splitExtractedKnowledge(extracted, { scope: 'group', provenance });
    s.memories = mergeMemories(s.memories || [], factsToMemoryItems(facts, { scope: 'group', source: 'llm', provenance }));
    s.graph = { edges: mergeGraphEdges(s.graph?.edges || [], edges) };
    changed = true;
  }
  const before = (s.memories || []).length;
  const beforeGraph = (s.graph?.edges || []).length;
  s.memories = pruneMemories(s.memories || []);
  s.graph = graphToPersist(s.graph);
  s.facts = memoriesToFacts(s.memories);
  if (s.memories.length !== before) changed = true;
  if ((s.graph?.edges || []).length !== beforeGraph) changed = true;
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

export const __testing = Object.freeze({
  mergeMemories,
  mergeGraphEdges,
  normalizeMemoryItems,
  normalizeGraphEdges,
});

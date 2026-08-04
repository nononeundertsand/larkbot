// 多模型注册表 + 能力档案 + 任务路由 + 运行时切换
//
// 目标：把「用哪个模型、这个模型支持什么参数、不同任务走哪个模型」集中管理，
//       让 requestLLM 只按档案裁剪请求体，从根上避免「模型不支持某参数」的 400。
//
// 三种切换粒度：
//   A. 配置档案：LLM_MODELS 定义多个模型档案；不配则由现有单模型 env 自动生成默认档案（向后兼容）。
//   B. 任务路由：LLM_ROUTE_<TASK> 把某类任务（chat/vision/fast/reasoning）指到具体模型。
//   C. 运行时切换：主人可临时改「默认模型」，存内存，重启回落 .env。
//
// 能力档案字段：
//   id            模型名（发给接口的 model 值 / azure deployment 名）
//   provider      azure | openai
//   endpoint/apiKey/apiVersion/baseUrl/apiUrl  连接信息（缺省回落全局 env）
//   temperature   'fixed'（不发 temperature 字段，用模型默认）| number（默认值）| undefined
//   tools         是否支持 function calling（默认 true）
//   vision        是否支持多模态图片（默认 false）
//   maxTokensField  'max_tokens' | 'max_completion_tokens' | ''（不发）
//   maxTokens     该模型默认输出 token 上限（调用显式 maxTokens 优先）
//   extraBody     额外透传到 Chat Completions body 的 JSON 对象，如 Gemini thinking 配置

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);

// 解析布尔型 env
function envBool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase());
}

// 解析 temperature 配置：'off'/'fixed'/'default' → 'fixed'（不发字段）；数字 → 该默认值；空 → undefined
function parseTemperature(raw) {
  if (raw == null || raw === '') return undefined;
  const s = String(raw).toLowerCase();
  if (['off', 'fixed', 'default', 'none'].includes(s)) return 'fixed';
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parsePositiveInt(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

function parseJsonObject(raw, label) {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : undefined;
  } catch (e) {
    console.error(`[models] ${label} 解析失败，忽略：`, e.message);
    return undefined;
  }
}

// 从全局 env 组一个「默认模型档案」（向后兼容：老配置只有 LLM_MODEL 也能跑）
function defaultProfileFromEnv() {
  return {
    id: process.env.LLM_MODEL || 'gpt-4o-mini',
    provider: (process.env.LLM_PROVIDER || 'openai').toLowerCase(),
    endpoint: process.env.LLM_AZURE_ENDPOINT || '',
    apiVersion: process.env.LLM_AZURE_API_VERSION || '2024-03-01-preview',
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || '',
    apiUrl: process.env.LLM_API_URL || '',
    temperature: parseTemperature(process.env.LLM_TEMPERATURE),
    tools: envBool(process.env.LLM_SUPPORTS_TOOLS, true),
    vision: envBool(process.env.LLM_SUPPORTS_VISION, true),
    maxTokensField: process.env.LLM_MAX_TOKENS_FIELD || 'max_tokens',
    maxTokens: parsePositiveInt(process.env.LLM_MAX_TOKENS),
    extraBody: parseJsonObject(process.env.LLM_EXTRA_BODY, 'LLM_EXTRA_BODY'),
  };
}

// 解析 LLM_MODELS（JSON 数组）为档案表。每条至少含 id；其余字段缺省回落全局 env。
function loadProfiles() {
  const map = new Map();
  const base = defaultProfileFromEnv();
  map.set(base.id, base);

  const raw = process.env.LLM_MODELS;
  if (raw) {
    let arr = [];
    try { arr = JSON.parse(raw); } catch (e) { console.error('[models] LLM_MODELS 解析失败，忽略：', e.message); }
    for (const item of Array.isArray(arr) ? arr : []) {
      if (!item || !item.id) continue;
      map.set(item.id, {
        id: item.id,
        provider: (item.provider || base.provider).toLowerCase(),
        endpoint: item.endpoint || base.endpoint,
        apiVersion: item.apiVersion || base.apiVersion,
        apiKey: item.apiKey || base.apiKey,
        baseUrl: item.baseUrl || base.baseUrl,
        apiUrl: item.apiUrl || base.apiUrl,
        temperature: 'temperature' in item ? parseTemperature(item.temperature) : base.temperature,
        tools: 'tools' in item ? Boolean(item.tools) : base.tools,
        vision: 'vision' in item ? Boolean(item.vision) : base.vision,
        maxTokensField: item.maxTokensField ?? base.maxTokensField,
        maxTokens: 'maxTokens' in item ? parsePositiveInt(item.maxTokens) : base.maxTokens,
        extraBody: 'extraBody' in item ? cloneJson(item.extraBody) : cloneJson(base.extraBody),
      });
    }
  }
  return map;
}

const PROFILES = loadProfiles();

// 运行时覆盖的默认模型（C：主人临时切换）；null 表示用 .env 默认
let runtimeDefaultModel = null;

// .env 里配置的默认模型 id
function envDefaultModelId() {
  return process.env.LLM_MODEL || [...PROFILES.keys()][0] || 'gpt-4o-mini';
}

// 任务 → 模型 id 的路由表（B）。未配置回落默认模型。
// 支持的任务名：chat / vision / fast / reasoning / summary / extract / safety / intent
function routeModelId(task) {
  const envKey = `LLM_ROUTE_${String(task || '').toUpperCase()}`;
  const routed = process.env[envKey];
  if (routed && PROFILES.has(routed)) return routed;
  if (routed && !PROFILES.has(routed)) {
    console.warn(`[models] 路由 ${envKey}=${routed} 未在档案表中，回落默认模型`);
  }
  return currentDefaultModelId();
}

// 当前默认模型：运行时覆盖优先，其次 .env
export function currentDefaultModelId() {
  if (runtimeDefaultModel && PROFILES.has(runtimeDefaultModel)) return runtimeDefaultModel;
  return envDefaultModelId();
}

// 列出所有可用模型 id
export function listModelIds() {
  return [...PROFILES.keys()];
}

// 主人运行时切换默认模型。返回 { ok, message }
export function setRuntimeDefaultModel(id) {
  const wanted = String(id || '').trim();
  if (!wanted) return { ok: false, message: '未指定模型名' };
  if (!PROFILES.has(wanted)) {
    return { ok: false, message: `未知模型「${wanted}」。可用：${listModelIds().join('、')}` };
  }
  runtimeDefaultModel = wanted;
  return { ok: true, message: `已切换默认模型为 ${wanted}` };
}

// 取某模型的能力档案（找不到回落默认档案）
export function getProfile(id) {
  return PROFILES.get(id) || PROFILES.get(currentDefaultModelId());
}

// 为一次调用挑选模型链：[主任务模型, 备用模型]（去重、去空、都必须在档案表内）
export function resolveModelChain({ task, model } = {}) {
  const chain = [];
  if (model && PROFILES.has(model)) chain.push(model); // 显式指定优先
  else if (task) chain.push(routeModelId(task));
  else chain.push(currentDefaultModelId());
  const fallback = process.env.LLM_FALLBACK_MODEL;
  if (fallback && PROFILES.has(fallback)) chain.push(fallback);
  return [...new Set(chain)];
}

// 解析连接信息（url + headers），按档案的 provider。
export function resolveRequestFor(profile) {
  if (!profile) return null;
  if (profile.provider === 'azure') {
    const endpoint = (profile.endpoint || '').replace(/\/+$/, '');
    if (!endpoint || !profile.apiKey) return null;
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(profile.id)}/chat/completions?api-version=${encodeURIComponent(profile.apiVersion)}`;
    return {
      url,
      headers: {
        'Content-Type': 'application/json',
        'api-key': profile.apiKey,
        'X-TT-LOGID': process.env.LLM_LOGID || `larkbot${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      },
    };
  }
  const url = profile.apiUrl || (profile.baseUrl ? profile.baseUrl.replace(/\/+$/, '') + '/chat/completions' : null);
  if (!url || !profile.apiKey) return null;
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
  };
}

// 按档案裁剪请求体：不支持自定义 temperature 就不发；不支持 tools 就丢 tools；max_tokens 字段名可配。
export function buildRequestBody(profile, { messages, tools, temperature, maxTokens }) {
  const body = { model: profile.id, messages };

  // temperature：'fixed' → 不发（用模型默认，兼容 GPT-5）；数字 → 用调用值或档案默认值
  if (profile.temperature !== 'fixed') {
    const t = temperature ?? (typeof profile.temperature === 'number' ? profile.temperature : undefined);
    if (typeof t === 'number') body.temperature = t;
  }
  // tools：仅当档案支持
  if (tools?.length && profile.tools !== false) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // max_tokens：字段名可配（GPT-5 系列用 max_completion_tokens）
  const wantedMaxTokens = maxTokens ?? profile.maxTokens;
  if (wantedMaxTokens && profile.maxTokensField) {
    body[profile.maxTokensField] = wantedMaxTokens;
  }
  // 额外模型参数：例如 Gemini thinking。避免覆盖核心协议字段。
  const extraBody = cloneJson(profile.extraBody);
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      if (['model', 'messages', 'tools', 'tool_choice'].includes(key)) continue;
      if (!(key in body)) body[key] = value;
    }
  }
  return body;
}

export const LLM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

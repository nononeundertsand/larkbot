function envBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|on|yes)$/i.test(String(value).trim());
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['conservative', 'normal', 'chatty'].includes(mode)) return mode;
  return 'normal';
}

export function groupAutonomyConfig(env = process.env) {
  const mode = normalizeMode(env.GROUP_AUTO_MODE || env.GROUP_AUTO_LEVEL);
  const defaultCooldown = mode === 'chatty' ? 45_000 : mode === 'conservative' ? 5 * 60_000 : 2 * 60_000;
  const defaultMaxPerHour = mode === 'chatty' ? 30 : mode === 'conservative' ? 4 : 12;
  const defaultMinMessagesSinceBot = mode === 'chatty' ? 1 : mode === 'conservative' ? 9999 : 3;
  return {
    autoParticipate: envBool(env.GROUP_AUTO_PARTICIPATE, false),
    autoIdleMessage: envBool(env.GROUP_IDLE_AUTO_MESSAGE, false),
    mode,
    cooldownMs: clampNumber(env.GROUP_AUTO_COOLDOWN_MS, 10_000, 24 * 3600 * 1000, defaultCooldown),
    idleMs: clampNumber(env.GROUP_IDLE_MS, 60_000, 7 * 24 * 3600 * 1000, 60 * 60 * 1000),
    idleCheckMs: clampNumber(env.GROUP_IDLE_CHECK_MS, 10_000, 24 * 3600 * 1000, 60_000),
    maxPerHour: clampNumber(env.GROUP_AUTO_MAX_PER_HOUR, 1, 120, defaultMaxPerHour),
    minTextChars: clampNumber(env.GROUP_AUTO_MIN_TEXT_CHARS, 1, 500, 4),
    minMessagesSinceBot: clampNumber(env.GROUP_AUTO_MIN_MESSAGES_SINCE_BOT, 1, 100, defaultMinMessagesSinceBot),
  };
}

export function createGroupActivity() {
  return {
    lastMessageAt: 0,
    lastBotAt: 0,
    recentBotReplies: [],
    messagesSinceBot: 0,
  };
}

export function noteGroupMessage(activity, at = Date.now()) {
  const base = { ...createGroupActivity(), ...(activity || {}) };
  return {
    ...base,
    lastMessageAt: at,
    messagesSinceBot: (Number(base.messagesSinceBot) || 0) + 1,
  };
}

export function noteGroupBotMessage(activity, at = Date.now()) {
  const base = { ...createGroupActivity(), ...(activity || {}) };
  return {
    ...base,
    lastBotAt: at,
    recentBotReplies: [...(base.recentBotReplies || []), at].filter((ts) => at - Number(ts) <= 3600 * 1000),
    messagesSinceBot: 0,
  };
}

function hasTrigger(text) {
  return /(机器人|bot|助理|助手|怎么看|对吗|怎么办|帮忙|谁来|总结|梳理|分析|解释|为什么|咋办|评评理|有空吗|在吗|会议|文档|材料|数据|图表|任务|待办|风险|方案|需求|bug|代码|攻防|测试|复盘|\?|\？)/i
    .test(String(text || ''));
}

function hasTopicSignal(text) {
  return /(今天|明天|最近|现在|刚刚|这个|那个|我们|大家|主人|项目|上线|进展|结论|问题|卡住|看看|一起|帮|要不要|可以|需要|忙什么|怎么弄)/i
    .test(String(text || ''));
}

function looksLikeNoise(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/^(哈+|哈哈+|hhh+|ok|嗯+|啊+|哦+|收到|1|。|\.)$/i.test(s)) return true;
  return false;
}

export function shouldAutoParticipate({
  text = '',
  mentioned = false,
  isBotSender = false,
  activity = {},
  config = groupAutonomyConfig(),
  now = Date.now(),
} = {}) {
  if (!config.autoParticipate) return { ok: false, reason: 'auto_participate_off' };
  if (mentioned) return { ok: false, reason: 'already_mentioned' };
  if (isBotSender) return { ok: false, reason: 'bot_sender' };
  const clean = String(text || '').trim();
  if (clean.length < config.minTextChars || looksLikeNoise(clean)) return { ok: false, reason: 'low_signal' };
  if (now - Number(activity.lastBotAt || 0) < config.cooldownMs) return { ok: false, reason: 'cooldown' };
  const recent = (activity.recentBotReplies || []).filter((ts) => now - Number(ts) <= 3600 * 1000);
  if (recent.length >= config.maxPerHour) return { ok: false, reason: 'hourly_limit' };
  if (hasTrigger(clean)) return { ok: true, reason: 'triggered' };
  if (config.mode !== 'conservative' && hasTopicSignal(clean)) return { ok: true, reason: 'topic_signal' };
  if (config.mode !== 'conservative' && Number(activity.messagesSinceBot || 0) >= config.minMessagesSinceBot) {
    return { ok: true, reason: 'conversation_burst' };
  }
  return { ok: false, reason: 'no_trigger' };
}

export function shouldSendIdleMessage({
  activity = {},
  config = groupAutonomyConfig(),
  now = Date.now(),
} = {}) {
  if (!config.autoIdleMessage) return { ok: false, reason: 'idle_off' };
  const lastMessageAt = Number(activity.lastMessageAt || 0);
  if (!lastMessageAt) return { ok: false, reason: 'no_activity' };
  if (now - lastMessageAt < config.idleMs) return { ok: false, reason: 'not_idle' };
  if (now - Number(activity.lastBotAt || 0) < config.idleMs) return { ok: false, reason: 'bot_recent' };
  const recent = (activity.recentBotReplies || []).filter((ts) => now - Number(ts) <= 3600 * 1000);
  if (recent.length >= config.maxPerHour) return { ok: false, reason: 'hourly_limit' };
  return { ok: true, reason: 'idle' };
}

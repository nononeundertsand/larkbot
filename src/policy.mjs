// Agent 能力策略中心。
//
// 权限与安全不能依赖 LLM 自觉，也不能分散在各工具的自然语言 description 中。
// 每个工具统一声明：
//   ownerOnly   是否仅主人可用
//   effect      read | write
//   dataClass   public | group | private | system
//   outputTrust trusted | external | private
//   silentEgress 是否会在无需二次确认的情况下访问外部网络
//   requiresCleanContext 是否禁止由外部/私密工具结果继续驱动该工具

const DEFAULT_POLICY = Object.freeze({
  ownerOnly: false,
  effect: 'read',
  dataClass: 'public',
  outputTrust: 'trusted',
  silentEgress: false,
  requiresCleanContext: false,
});

const TOOL_POLICIES = Object.freeze({
  lookup_user: { dataClass: 'public', outputTrust: 'trusted' },
  get_chat_members: { dataClass: 'group', outputTrust: 'external' },
  get_user_recent_messages: { dataClass: 'group', outputTrust: 'external' },
  summarize_chat: { dataClass: 'group', outputTrust: 'external' },
  get_recent_chat_context: { dataClass: 'group', outputTrust: 'external' },

  calendar_agenda: { ownerOnly: true, dataClass: 'private', outputTrust: 'private' },
  calendar_create: { ownerOnly: true, effect: 'write', dataClass: 'private' },
  calendar_delete: { ownerOnly: true, effect: 'write', dataClass: 'private' },
  task_list: { ownerOnly: true, dataClass: 'private', outputTrust: 'private' },
  task_create: { ownerOnly: true, effect: 'write', dataClass: 'private' },
  send_message: { ownerOnly: true, effect: 'write', dataClass: 'private' },
  mail_triage: { ownerOnly: true, dataClass: 'private', outputTrust: 'private' },
  mail_send: { ownerOnly: true, effect: 'write', dataClass: 'private' },

  web_fetch: { outputTrust: 'external', silentEgress: true },
  web_search: { outputTrust: 'external', silentEgress: true },

  // 访客可用的安全代码执行：只在无挂载、无网络 Docker Python 沙箱中运行，输出视为不可信外部数据。
  run_python_code: { dataClass: 'public', outputTrust: 'external' },

  list_lark_skills: { dataClass: 'system', outputTrust: 'trusted' },
  read_lark_skill: { dataClass: 'system', outputTrust: 'trusted' },

  // 运行时切换默认模型：仅主人，改运行时状态视为写（但无飞书副作用，故不走二次确认）。
  switch_model: { ownerOnly: true, effect: 'write', dataClass: 'system', outputTrust: 'trusted' },
  list_models: { ownerOnly: true, dataClass: 'system', outputTrust: 'trusted' },
  start_user_auth: { ownerOnly: true, effect: 'write', dataClass: 'system', outputTrust: 'trusted' },

  // 元工具能力面过大，只允许主人使用；命令本身再做正向只读分类。
  run_lark_cli: { ownerOnly: true, dataClass: 'private', outputTrust: 'private' },

  // Shell 能力比普通工具危险：主人可直接使用受限命令；访客只允许发起 Docker 隔离下载，
  // 并在工具层转为主人确认。输出默认按私密数据处理，下载类调用会在 getToolMetadata 中降为 external。
  run_shell_command: {
    dataClass: 'private',
    outputTrust: 'private',
    requiresCleanContext: true,
  },
});

// 只读判定采用 allowlist：无法确认只读的命令一律视为写操作并要求确认。
const READ_ONLY_TOKEN_RE =
  /(^|[+_-])(get|list|search|fetch|read|mget|agenda|freebusy|triage|messages?|threads?|members?|calendars?|spaces?|nodes?|records?|fields?|views?|tables?|query|status|profile|info|suggestion)([+_-]|$)/i;
const LOCAL_WRITE_FLAGS = new Set([
  '--output',
  '--output-path',
  '--output-dir',
  '--overwrite',
  '--yes',
  '--confirm',
  '--confirm-send',
]);
const NO_IDENTITY_FLAG_ROOTS = new Set(['auth', 'config', 'update']);

export function getToolPolicy(name) {
  return Object.freeze({ ...DEFAULT_POLICY, ...(TOOL_POLICIES[name] || {}) });
}

export function authorizeTool(name, _args, ctx = {}) {
  const policy = getToolPolicy(name);
  if (policy.ownerOnly && !ctx.isOwner) {
    return { ok: false, policy, reason: '该工具仅限主人使用' };
  }
  return { ok: true, policy };
}

// 防止不可信网页/群消息驱动读取主人私有数据，也防止私有数据通过无需确认的网络工具外传。
export function authorizeToolTransition(policy, state = {}) {
  if (policy.requiresCleanContext && state.externalTaint) {
    return {
      ok: false,
      reason: '为防止外部内容或群消息中的提示词注入诱导执行本机命令，请把 Shell 操作作为一条新的独立请求发给我。',
    };
  }
  if (policy.requiresCleanContext && state.privateDataRead) {
    return {
      ok: false,
      reason: '本轮已读取私密数据，出于防泄露考虑不能继续执行本机命令。请另起一条请求。',
    };
  }
  if (state.externalTaint && policy.dataClass === 'private' && policy.effect === 'read') {
    return {
      ok: false,
      reason: '为防止外部内容诱导读取私密数据，请把该私密查询作为一条新的独立请求发给我。',
    };
  }
  if (state.privateDataRead && policy.silentEgress) {
    return {
      ok: false,
      reason: '本轮已读取私密数据，出于防泄露考虑不能继续访问外部网络。请另起一条请求。',
    };
  }
  return { ok: true };
}

export function classifyLarkArgs(rawArgs, { isOwner } = {}) {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return { ok: false, reason: '命令参数为空' };
  }
  const args = rawArgs.map((a) => String(a));
  if (args.some((a) => /[;&|`$><\n]/.test(a))) {
    return { ok: false, reason: '参数包含非法字符' };
  }

  const asIndex = args.indexOf('--as');
  const identity = asIndex >= 0 ? String(args[asIndex + 1] || '') : 'bot';
  if (NO_IDENTITY_FLAG_ROOTS.has(args[0]) && asIndex >= 0) {
    return { ok: false, reason: `${args[0]} 是 lark-cli 全局命令，不支持 --as；请移除 --as 后重试` };
  }
  if (!isOwner && identity === 'user') {
    return { ok: false, reason: '访客不可使用主人的 user 身份' };
  }

  let effect = 'write';
  if (args[0] === 'api') {
    const method = (args[1] || '').toUpperCase();
    effect = method === 'GET' ? 'read' : 'write';
  } else if (args.includes('--dry-run')) {
    effect = 'read';
  } else if (args.some((arg) => LOCAL_WRITE_FLAGS.has(arg))) {
    effect = 'write';
  } else {
    const commandPath = [];
    for (const arg of args) {
      if (arg.startsWith('--')) break;
      commandPath.push(arg);
    }
    const action = commandPath.at(-1) || '';
    if (READ_ONLY_TOKEN_RE.test(action)) effect = 'read';
  }

  return { ok: true, args, identity, effect, isWrite: effect === 'write' };
}

const DEFAULT_STYLE = (process.env.SECURITY_REFUSAL_STYLE || 'teasing').toLowerCase();

const RISK_TYPES = [
  {
    type: 'local_command',
    label: '本机命令执行',
    reason: '该请求试图让助理执行本机或终端命令，可能越过工具权限边界。',
    patterns: [
      /(Shell 命令|Shell 操作|本机命令|终端命令|命令审核拒绝)/i,
      /(执行|运行|调用|帮我跑|跑一下|run|execute).{0,16}(本机|终端|shell|命令|cmd|command|bash|zsh|ls|pwd|cat|find|grep|rg|git|npm|node|python)/i,
      /\b(ls|pwd|cat|find|grep|rg|git|npm)\b.{0,24}(结果|输出|返回|给我|目录|文件|status|test|check)/i,
    ],
  },
  {
    type: 'filesystem_read',
    label: '文件系统探测',
    reason: '该请求试图读取或返回本机目录、文件系统、配置文件或运行时数据，可能泄露敏感信息。',
    patterns: [
      /(列出|读取|返回|查看|展示).{0,16}(文件系统|目录|当前目录|工作区|workspace|根目录|本机文件|配置文件|环境变量|\.env)/i,
      /(file system|filesystem|directory|local file|env file|environment variable)/i,
    ],
  },
  {
    type: 'credential_request',
    label: '凭证索取',
    reason: '该请求涉及 token、密钥、密码、私钥或环境变量，可能造成凭证泄露。',
    patterns: [
      /(api[-_ ]?key|access[-_]?key|secret|password|credential|private\s+key)/i,
      /(给我|发我|告诉我|查看|读取|展示|输出|打印|泄露|拿到|获取|提供|复制|贴出).{0,20}(token|access token|refresh token|bearer token|令牌)/i,
      /(token|access token|refresh token|bearer token|令牌).{0,20}(给我|发我|告诉我|查看|读取|展示|输出|打印|泄露|拿到|获取|提供|复制|贴出)/i,
      /(密码|密钥|口令|私钥|凭证|环境变量|配置文件|\.env)/i,
    ],
  },
  {
    type: 'prompt_injection',
    label: '提示词注入 / 越权改写',
    reason: '该请求试图改变助理身份、忽略既有规则、输出系统提示词或绕过安全策略。',
    patterns: [
      /忽略(上面|之前|以上|前面).{0,8}(指令|规则|提示|设定)/i,
      /ignore\s+(the\s+)?(above|previous|prior|all).{0,16}(instruction|rule|prompt)/i,
      /(你现在是|从现在起你是|假装你是|扮演|pretend to be|you are now)/i,
      /(system prompt|系统提示|系统提示词|你的提示词|你的设定|初始指令)/i,
      /(开发者模式|developer mode|越狱|jailbreak|DAN模式)/i,
    ],
  },
  {
    type: 'owner_private_data',
    label: '主人私密数据访问',
    reason: '该请求涉及主人的私聊、个人消息、日程、邮件或其它私人数据，访客无权访问。',
    patterns: [
      /(主人|owner|用户本人|刘老师).{0,16}(私聊|私信|个人消息|聊天记录|日程|邮件|邮箱|任务|待办)/i,
      /(private message|personal message|calendar|mailbox|email).{0,24}(owner|主人|用户本人|刘老师)/i,
    ],
  },
  {
    type: 'owner_only_tool',
    label: '主人专属能力访问',
    reason: '该请求试图调用主人专属工具或使用主人的 user 身份，访客无权触发这类能力。',
    patterns: [
      /(仅限主人|主人专属|访客不可使用主人的 user 身份|ownerOnly|owner only)/i,
      /(calendar|task|mail|send_message|run_lark_cli|start_user_auth).{0,24}(仅限|主人|owner)/i,
    ],
  },
  {
    type: 'data_flow_guard',
    label: '敏感信息流拦截',
    reason: '该请求会让外部不可信内容驱动私密读取，或在读取私密数据后继续外联，存在数据外泄风险。',
    patterns: [
      /(外部内容诱导读取私密数据|读取私密数据.*外部网络|防泄露|静默访问外部网络|私密查询)/i,
      /(external.*private|private.*egress|data exfiltration)/i,
    ],
  },
  {
    type: 'ssrf_or_internal_probe',
    label: '内网 / 本地探测',
    reason: '该请求试图访问内网、本地地址、云元数据或受保护网络位置，可能被用于 SSRF 或环境探测。',
    patterns: [
      /(内网|本地地址|localhost|127\.0\.0\.1|169\.254\.169\.254|云元数据|目标解析到内网|跨主机重定向|SSRF)/i,
      /(metadata|link-local|private ip|loopback|internal network)/i,
    ],
  },
];

export function classifySafetyRisk(text = '', reason = '') {
  const reasonText = String(reason || '');
  for (const item of RISK_TYPES) {
    if (reasonText && item.patterns.some((re) => re.test(reasonText))) {
      return { type: item.type, label: item.label, reason: item.reason };
    }
  }
  const corpus = `${text}\n${reason}`;
  for (const item of RISK_TYPES) {
    if (item.patterns.some((re) => re.test(corpus))) {
      return { type: item.type, label: item.label, reason: item.reason };
    }
  }
  return {
    type: 'unsafe_request',
    label: '越权或敏感请求',
    reason: reason || '该请求可能触碰身份、权限或数据边界，继续执行存在安全风险。',
  };
}

export function formatSafetyRefusal({ text = '', reason = '', ownerName = '主人', style = DEFAULT_STYLE } = {}) {
  const risk = classifySafetyRisk(text, reason);
  const header = style === 'firm'
    ? '该请求已被安全策略拒绝。'
    : '这条请求已被安全策略拦下。';
  const tail = style === 'firm'
    ? '如需正常协助，请换成不涉及越权、凭证或本机数据读取的请求。'
    : '换个正常问题我会继续答；这种越权路线就别浪费轮次了。';

  return [
    header,
    '',
    `安全判断：${risk.label}。`,
    `风险原因：${risk.reason}`,
    `处理结果：不会执行该请求，不会读取或返回${ownerName}的私密信息，也不会触碰本机敏感数据。`,
    '',
    tail,
  ].join('\n');
}

export function makeSafetyRefusal({ text = '', reason = '', ownerName = '主人', style = DEFAULT_STYLE } = {}) {
  return {
    refused: true,
    securityRefusal: true,
    reason,
    message: formatSafetyRefusal({ text, reason, ownerName, style }),
  };
}

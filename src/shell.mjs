import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { isIP } from 'node:net';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const DOCKER_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEFAULT_DOCKER_IMAGE = 'larkbot-shell-sandbox:latest';
const DOCKER_WORKSPACE = '/workspace';
const PYTHON_SANDBOX_WORKDIR = '/tmp';

const READ_COMMANDS = new Set(['pwd', 'ls', 'find', 'rg', 'grep', 'cat', 'head', 'tail', 'wc', 'git']);
const PYTHON_COMMANDS = new Set(['python', 'python3']);
const APT_DOWNLOAD_COMMANDS = new Set(['apt', 'apt-get']);
const URL_DOWNLOAD_COMMANDS = new Set(['curl', 'wget']);
const FORBIDDEN_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'osascript',
  'nc', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync',
  'rm', 'mv', 'cp', 'dd', 'chmod', 'chown', 'sudo', 'su', 'kill', 'pkill',
  'docker', 'kubectl', 'terraform', 'ansible',
  'node', 'perl', 'ruby', 'php',
]);
const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse', 'ls-files', 'grep']);
const NPM_ALLOWED = new Set(['test']);
const NPM_RUN_ALLOWED = new Set(['check', 'test']);
const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[a-zA-Z0-9:~+.-]+)?$/;
const DOWNLOAD_OUTPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,119}$/;
const CURL_BOOLEAN_FLAGS = new Set([
  '-f', '--fail',
  '-L', '--location',
  '-O', '--remote-name',
  '-J', '--remote-header-name',
  '-s', '--silent',
  '-S', '--show-error',
  '--compressed',
]);
const CURL_VALUE_FLAGS = new Set(['-o', '--output']);
const CURL_NUMBER_FLAGS = new Set(['--max-redirs', '--connect-timeout', '--retry']);
const WGET_BOOLEAN_FLAGS = new Set([
  '-q', '--quiet',
  '-S', '--server-response',
  '-nv', '--no-verbose',
  '--content-disposition',
]);
const WGET_VALUE_FLAGS = new Set(['-O', '--output-document']);
const WGET_NUMBER_FLAGS = new Set(['--timeout', '--tries', '--max-redirect']);

const SENSITIVE_ARG_RE =
  /(^|[/\\])(?:\.env(?:\..*)?|\.ssh|\.aws|\.kube|\.docker|id_rsa|id_ed25519|known_hosts|credentials?|secrets?|tokens?)([/\\]|$)/i;
const CONTROL_CHAR_RE = /[\0\r\n]/;
const PYTHON_CODE_CONTROL_CHAR_RE = /[\0\r]/;
const RG_UNSAFE_FLAGS = new Set(['--hidden', '--no-ignore', '--no-ignore-global', '--no-ignore-parent', '--unrestricted', '--follow', '-L']);
const FIND_UNSAFE_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls']);

function envBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|on|yes)$/i.test(String(value).trim());
}

function clamp(n, min, max, fallback) {
  const value = Number(n);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function shellEnabled() {
  return envBool(process.env.SHELL_ENABLED, false);
}

export function shellDockerEnabled() {
  return envBool(process.env.SHELL_DOCKER_ENABLED, false);
}

export function shellSandboxRoot() {
  return resolve(process.env.SHELL_SANDBOX_ROOT || PROJECT_ROOT);
}

export function pythonCodeSandboxAvailable() {
  return shellEnabled() && shellDockerEnabled();
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeCwd(cwd = '.') {
  const root = shellSandboxRoot();
  const raw = String(cwd || '.').trim() || '.';
  if (CONTROL_CHAR_RE.test(raw)) return { ok: false, reason: 'cwd 包含控制字符' };
  if (isAbsolute(raw) || raw.startsWith('~')) return { ok: false, reason: 'cwd 必须是沙箱内的相对路径' };
  if (raw.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'cwd 不允许路径穿越' };
  const full = resolve(root, raw);
  if (!isInside(root, full)) return { ok: false, reason: 'cwd 越过了 Shell 沙箱目录' };
  if (!existsSync(full)) return { ok: false, reason: `cwd 不存在：${raw}` };
  try {
    if (!statSync(full).isDirectory()) return { ok: false, reason: `cwd 不是目录：${raw}` };
  } catch (err) {
    return { ok: false, reason: `无法读取 cwd：${err.message}` };
  }
  return { ok: true, root, cwd: full, cwdLabel: raw === '.' ? '.' : raw };
}

function normalizeCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, reason: '缺少 command' };
  if (cmd !== basename(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return { ok: false, reason: 'command 只能是可执行文件名，不能包含路径' };
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(cmd)) {
    return { ok: false, reason: 'command 含非法字符' };
  }
  if (cmd.startsWith('.')) return { ok: false, reason: '不允许执行隐藏或相对可执行文件' };
  return { ok: true, command: cmd };
}

function normalizeArgs(args, { maxArgLength = 1000, allowMultilineIndexes = new Set() } = {}) {
  if (args == null) return { ok: true, args: [] };
  if (!Array.isArray(args)) return { ok: false, reason: 'args 必须是字符串数组' };
  if (args.length > 60) return { ok: false, reason: '参数过多' };
  const out = [];
  for (const [index, raw] of args.entries()) {
    const arg = String(raw);
    if (arg.length > maxArgLength) return { ok: false, reason: '单个参数过长' };
    if (allowMultilineIndexes.has(index)) {
      if (PYTHON_CODE_CONTROL_CHAR_RE.test(arg)) return { ok: false, reason: '参数包含非法控制字符' };
    } else if (CONTROL_CHAR_RE.test(arg)) {
      return { ok: false, reason: '参数包含控制字符' };
    }
    if (arg.startsWith('~') || isAbsolute(arg)) return { ok: false, reason: '不允许使用绝对路径或家目录路径' };
    if (arg.split(/[\\/]+/).includes('..')) return { ok: false, reason: '参数不允许路径穿越' };
    if (SENSITIVE_ARG_RE.test(arg)) return { ok: false, reason: '参数命中敏感路径或凭证文件名' };
    out.push(arg);
  }
  return { ok: true, args: out };
}

function containsFlag(args, flagSet) {
  return args.some((arg) => flagSet.has(arg) || [...flagSet].some((flag) => arg.startsWith(`${flag}=`)));
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv4FromMappedIpv6(ip) {
  const lower = String(ip || '').toLowerCase();
  if (!lower.startsWith('::ffff:')) return '';
  const tail = lower.slice('::ffff:'.length);
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || !parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return '';
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isPrivateIp(ip) {
  const normalized = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isPrivateIpv4(mapped);
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    normalized.startsWith('2001:db8:')
  );
}

function vetDownloadUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (text.length > 2048) return { ok: false, reason: '下载 URL 过长' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, reason: `下载 URL 格式不正确：${text}` }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: '下载命令仅允许 http/https URL' };
  if (u.username || u.password) return { ok: false, reason: '下载 URL 不允许携带用户名或密码' };
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, reason: '下载 URL 缺少主机名' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: '下载命令不允许访问本地或内网主机名' };
  }
  if (isIP(host) && isPrivateIp(host)) {
    return { ok: false, reason: '下载命令不允许访问内网、本地或云元数据地址' };
  }
  if (!isIP(host) && !host.includes('.')) {
    return { ok: false, reason: '下载命令不允许访问单标签主机名，避免内网探测' };
  }
  return { ok: true };
}

function isSafeDownloadOutputName(value) {
  const name = String(value || '');
  return DOWNLOAD_OUTPUT_RE.test(name) && name === basename(name) && !SENSITIVE_ARG_RE.test(name);
}

function vetDownloadNumber(raw, { min = 0, max = 30, label = '参数值' } = {}) {
  if (!/^\d{1,3}$/.test(String(raw || ''))) return { ok: false, reason: `${label} 必须是整数` };
  const value = Number(raw);
  if (value < min || value > max) return { ok: false, reason: `${label} 超出允许范围` };
  return { ok: true };
}

function pushDownloadUrl(urls, raw) {
  const vetted = vetDownloadUrl(raw);
  if (!vetted.ok) return vetted;
  urls.push(String(raw));
  if (urls.length > 3) return { ok: false, reason: '下载命令单次最多允许 3 个 URL' };
  return { ok: true };
}

function reviewCurlDownload(args) {
  const urls = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (CURL_BOOLEAN_FLAGS.has(arg) || /^-[fLOJsS]+$/.test(arg)) continue;
    if (CURL_VALUE_FLAGS.has(arg)) {
      const output = args[i + 1] || '';
      if (!isSafeDownloadOutputName(output)) return { ok: false, reason: `curl 输出文件名不安全：${output || '(空)'}` };
      i += 1;
      continue;
    }
    const outputPrefix = ['--output='].find((prefix) => arg.startsWith(prefix));
    if (outputPrefix) {
      const output = arg.slice(outputPrefix.length);
      if (!isSafeDownloadOutputName(output)) return { ok: false, reason: `curl 输出文件名不安全：${output || '(空)'}` };
      continue;
    }
    const numericPrefix = [...CURL_NUMBER_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (numericPrefix) {
      const checked = vetDownloadNumber(arg.slice(numericPrefix.length + 1), { max: numericPrefix === '--retry' ? 3 : 30, label: numericPrefix });
      if (!checked.ok) return checked;
      continue;
    }
    if (CURL_NUMBER_FLAGS.has(arg)) {
      const value = args[i + 1] || '';
      const checked = vetDownloadNumber(value, { max: arg === '--retry' ? 3 : 30, label: arg });
      if (!checked.ok) return checked;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, reason: `curl 参数不在下载 allowlist 内：${arg}` };
    const pushed = pushDownloadUrl(urls, arg);
    if (!pushed.ok) return pushed;
  }
  if (urls.length === 0) return { ok: false, reason: 'curl 下载缺少 URL' };
  return { ok: true };
}

function reviewWgetDownload(args) {
  const urls = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (WGET_BOOLEAN_FLAGS.has(arg)) continue;
    if (WGET_VALUE_FLAGS.has(arg)) {
      const output = args[i + 1] || '';
      if (!isSafeDownloadOutputName(output)) return { ok: false, reason: `wget 输出文件名不安全：${output || '(空)'}` };
      i += 1;
      continue;
    }
    if (arg.startsWith('-O') && arg.length > 2) {
      const output = arg.slice(2);
      if (!isSafeDownloadOutputName(output)) return { ok: false, reason: `wget 输出文件名不安全：${output || '(空)'}` };
      continue;
    }
    const outputPrefix = ['--output-document='].find((prefix) => arg.startsWith(prefix));
    if (outputPrefix) {
      const output = arg.slice(outputPrefix.length);
      if (!isSafeDownloadOutputName(output)) return { ok: false, reason: `wget 输出文件名不安全：${output || '(空)'}` };
      continue;
    }
    const numericPrefix = [...WGET_NUMBER_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (numericPrefix) {
      const checked = vetDownloadNumber(arg.slice(numericPrefix.length + 1), { min: 1, max: numericPrefix === '--tries' ? 3 : 30, label: numericPrefix });
      if (!checked.ok) return checked;
      continue;
    }
    if (WGET_NUMBER_FLAGS.has(arg)) {
      const value = args[i + 1] || '';
      const checked = vetDownloadNumber(value, { min: 1, max: arg === '--tries' ? 3 : 30, label: arg });
      if (!checked.ok) return checked;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, reason: `wget 参数不在下载 allowlist 内：${arg}` };
    const pushed = pushDownloadUrl(urls, arg);
    if (!pushed.ok) return pushed;
  }
  if (urls.length === 0) return { ok: false, reason: 'wget 下载缺少 URL' };
  return { ok: true };
}

function reviewGit(args) {
  if (args.some((arg) => arg === '-C' || arg.startsWith('--git-dir') || arg.startsWith('--work-tree'))) {
    return { ok: false, reason: 'git 不允许切换仓库路径或指定 git-dir/work-tree' };
  }
  const sub = args.find((arg) => !arg.startsWith('-')) || 'status';
  if (!GIT_READ_SUBCOMMANDS.has(sub)) {
    return { ok: false, reason: `git ${sub} 不在只读 allowlist 内` };
  }
  return { ok: true, effect: 'read', risk: 'low', reason: 'git 只读子命令' };
}

function reviewFind(args) {
  if (containsFlag(args, FIND_UNSAFE_FLAGS)) {
    return { ok: false, reason: 'find 参数包含会执行命令或写文件的谓词' };
  }
  return { ok: true, effect: 'read', risk: 'low', reason: '文件枚举只读命令' };
}

function reviewRipgrep(args) {
  if (containsFlag(args, RG_UNSAFE_FLAGS) || args.some((arg) => /^-u{1,3}$/.test(arg))) {
    return { ok: false, reason: 'rg 不允许绕过 ignore/hidden 限制或跟随符号链接' };
  }
  return { ok: true, effect: 'read', risk: 'low', reason: '文本搜索只读命令' };
}

function reviewNpm(args) {
  if (!envBool(process.env.SHELL_ALLOW_PROJECT_COMMANDS, false)) {
    return { ok: false, reason: '项目脚本默认禁用；如确需开放，请设置 SHELL_ALLOW_PROJECT_COMMANDS=on' };
  }
  const sub = args[0] || '';
  if (NPM_ALLOWED.has(sub)) {
    return { ok: true, effect: 'write', risk: 'high', reason: '项目脚本会执行仓库代码，必须二次确认' };
  }
  if (sub === 'run' && NPM_RUN_ALLOWED.has(args[1] || '')) {
    return { ok: true, effect: 'write', risk: 'high', reason: '项目脚本会执行仓库代码，必须二次确认' };
  }
  return { ok: false, reason: 'npm 仅允许 test / run check / run test，且必须显式启用项目脚本' };
}

function reviewAptDownload(args) {
  if (!shellDockerEnabled()) {
    return { ok: false, reason: 'apt 下载仅允许在 Docker runner 中执行；本机 runner 不开放 apt' };
  }
  const sub = args[0] || '';
  if (sub !== 'download') {
    return { ok: false, reason: 'apt 仅允许 download 子命令；不允许 install/update/upgrade/remove 等修改系统的操作' };
  }
  const packages = args.slice(1);
  if (packages.length === 0) return { ok: false, reason: 'apt download 缺少包名' };
  if (packages.length > 5) return { ok: false, reason: 'apt download 单次最多允许 5 个包' };
  const bad = packages.find((pkg) => pkg.startsWith('-') || !APT_PACKAGE_RE.test(pkg));
  if (bad) return { ok: false, reason: `apt 包名不在安全格式 allowlist 内：${bad}` };
  return {
    ok: true,
    effect: 'read',
    risk: 'medium',
    reason: 'Docker 内 apt download，仅下载 .deb 到容器 /tmp，不安装、不触碰宿主机',
    docker: { network: 'bridge', mountWorkspace: false, workdir: '/tmp' },
  };
}

function reviewUrlDownload(command, args) {
  if (!shellDockerEnabled()) {
    return { ok: false, reason: `${command} 下载仅允许在 Docker runner 中执行；本机 runner 不开放联网下载` };
  }
  const reviewed = command === 'curl' ? reviewCurlDownload(args) : reviewWgetDownload(args);
  if (!reviewed.ok) return reviewed;
  return {
    ok: true,
    effect: 'read',
    risk: 'medium',
    reason: `Docker 内 ${command} 受限下载，仅允许公开 http/https URL，输出限制在容器 /tmp`,
    docker: { network: 'bridge', mountWorkspace: false, workdir: '/tmp' },
  };
}

function reviewPython(args) {
  if (!shellDockerEnabled()) {
    return { ok: false, reason: 'Python 仅允许在 Docker runner 中执行；本机 runner 不开放 Python' };
  }
  if (dockerWorkspaceMode() !== 'ro') {
    return { ok: false, reason: 'Python 仅允许在只读 Docker workspace 中执行，请保持 SHELL_DOCKER_WORKSPACE_MODE=ro' };
  }
  if (args.length === 0) return { ok: false, reason: 'Python 需要使用 -c 代码片段或指定沙箱内 .py 文件，不能进入交互模式' };
  if (args[0] === '-c') {
    const code = String(args[1] || '');
    if (!code.trim()) return { ok: false, reason: 'python -c 缺少代码内容' };
    return { ok: true, effect: 'write', risk: 'high', reason: 'Docker 内 Python 代码执行' };
  }
  const script = args.find((arg) => !arg.startsWith('-')) || '';
  if (!script.endsWith('.py')) {
    return { ok: false, reason: 'Python 仅允许 python3 -c "<code>" 或执行沙箱内 .py 文件' };
  }
  return { ok: true, effect: 'write', risk: 'high', reason: 'Docker 内 Python 脚本执行' };
}

function reviewCommandProfile(command, args) {
  if (APT_DOWNLOAD_COMMANDS.has(command)) return reviewAptDownload(args);
  if (URL_DOWNLOAD_COMMANDS.has(command)) return reviewUrlDownload(command, args);
  if (PYTHON_COMMANDS.has(command)) return reviewPython(args);
  if (FORBIDDEN_COMMANDS.has(command)) return { ok: false, reason: `${command} 属于禁用命令` };
  if (command === 'npm') return reviewNpm(args);
  if (!READ_COMMANDS.has(command)) return { ok: false, reason: `${command} 不在 Shell 命令 allowlist 内` };
  if (command === 'git') return reviewGit(args);
  if (command === 'find') return reviewFind(args);
  if (command === 'rg') return reviewRipgrep(args);
  if (command === 'pwd' && args.length > 1) return { ok: false, reason: 'pwd 参数过多' };
  return { ok: true, effect: 'read', risk: 'low', reason: '只读 allowlist 命令' };
}

function shellRequiresConfirmation(_profile) {
  if (envBool(process.env.SHELL_CONFIRM_ALL, false)) return true;
  // 兜底：只要落到本机 runner，就可能读写 Mac 文件系统，必须由主人确认。
  if (!shellDockerEnabled()) return true;
  // Docker 若被配置成 rw 挂载 workspace，也会影响本地项目文件，仍必须确认。
  if (dockerWorkspaceMode() === 'rw') return true;
  return false;
}

export function formatShellCommand(command, args = []) {
  const quote = (value) => /^[A-Za-z0-9_./:=@%+-]+$/.test(String(value))
    ? String(value)
    : JSON.stringify(String(value));
  return [command, ...args.map(quote)].join(' ');
}

export function reviewShellCommand(input = {}) {
  const cmd = normalizeCommand(input.command);
  if (!cmd.ok) return { ok: false, reason: cmd.reason };
  const rawArgs = Array.isArray(input.args) ? input.args.map((x) => String(x)) : input.args;
  const pythonCodeArg = PYTHON_COMMANDS.has(cmd.command) && rawArgs?.[0] === '-c' ? new Set([1]) : new Set();
  const argv = normalizeArgs(input.args, {
    maxArgLength: PYTHON_COMMANDS.has(cmd.command) ? 8000 : 1000,
    allowMultilineIndexes: pythonCodeArg,
  });
  if (!argv.ok) return { ok: false, reason: argv.reason, command: cmd.command };
  const dir = normalizeCwd(input.cwd || '.');
  if (!dir.ok) return { ok: false, reason: dir.reason, command: cmd.command, args: argv.args };

  const profile = reviewCommandProfile(cmd.command, argv.args);
  if (!profile.ok) return { ok: false, reason: profile.reason, command: cmd.command, args: argv.args };

  const requiresConfirmation = shellRequiresConfirmation(profile);
  const timeoutMs = clamp(process.env.SHELL_TIMEOUT_MS, 1000, 60000, 10000);
  const maxOutputBytes = clamp(process.env.SHELL_MAX_OUTPUT_BYTES, 1024, 200000, 50000);
  const purpose = String(input.purpose || '').trim().slice(0, 300);
  const action = {
    command: cmd.command,
    args: argv.args,
    cwd: dir.cwdLabel,
    purpose,
  };
  return {
    ok: true,
    command: cmd.command,
    args: argv.args,
    cwd: dir.cwd,
    cwdLabel: dir.cwdLabel,
    root: dir.root,
    purpose,
    effect: profile.effect,
    risk: profile.risk,
    reviewReason: profile.reason,
    requiresConfirmation,
    timeoutMs,
    maxOutputBytes,
    action,
    audit: {
      command: formatShellCommand(cmd.command, argv.args),
      effect: profile.effect,
      risk: profile.risk,
      reason: profile.reason,
      requiresConfirmation,
      confirmationReason: requiresConfirmation
        ? (shellDockerEnabled() && dockerWorkspaceMode() === 'rw'
          ? 'Docker workspace 以 rw 挂载，会影响本地 Mac 项目文件'
          : (shellDockerEnabled() ? 'SHELL_CONFIRM_ALL 强制确认' : '本机 Mac 文件系统访问兜底确认'))
        : 'Docker 只读隔离环境无需人工确认',
      sandboxCwd: dir.cwdLabel,
      timeoutMs,
      maxOutputBytes,
      runner: shellDockerEnabled() ? 'docker' : 'local',
      dockerImage: shellDockerEnabled() ? dockerImage() : '',
      dockerNetwork: profile.docker?.network || 'none',
      workspaceMounted: profile.docker?.mountWorkspace !== false,
    },
    docker: profile.docker || {},
  };
}

function ensureSandboxRuntime(root) {
  const base = join(root, '.local', 'shell-runtime');
  const home = join(base, 'home');
  const tmp = join(base, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { home, tmp };
}

function sandboxEnv(root) {
  const { home, tmp } = ensureSandboxRuntime(root);
  return {
    PATH: process.env.SHELL_PATH || DEFAULT_PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: resolve(root, '..'),
    npm_config_cache: join(home, '.npm'),
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

function dockerImage() {
  return String(process.env.SHELL_DOCKER_IMAGE || DEFAULT_DOCKER_IMAGE).trim() || DEFAULT_DOCKER_IMAGE;
}

function dockerBin() {
  return String(process.env.SHELL_DOCKER_BIN || 'docker').trim() || 'docker';
}

function dockerWorkspaceMode() {
  return String(process.env.SHELL_DOCKER_WORKSPACE_MODE || 'ro').toLowerCase() === 'rw' ? 'rw' : 'ro';
}

function dockerCpus() {
  const value = String(process.env.SHELL_DOCKER_CPUS || '1').trim();
  return /^\d+(?:\.\d+)?$/.test(value) ? value : '1';
}

function dockerMemory() {
  const value = String(process.env.SHELL_DOCKER_MEMORY || '512m').trim().toLowerCase();
  return /^\d+[bkmg]?$/.test(value) ? value : '512m';
}

function dockerPidsLimit() {
  return String(clamp(process.env.SHELL_DOCKER_PIDS_LIMIT, 16, 1024, 128));
}

function dockerPullPolicy() {
  const value = String(process.env.SHELL_DOCKER_PULL || 'never').trim().toLowerCase();
  return ['never', 'missing', 'always'].includes(value) ? value : 'never';
}

function dockerUser() {
  const value = String(process.env.SHELL_DOCKER_USER || '1000:1000').trim();
  return /^\d+(?::\d+)?$/.test(value) ? value : '1000:1000';
}

function containerCwd(review) {
  if (review.docker?.workdir) return review.docker.workdir;
  return review.cwdLabel === '.' ? DOCKER_WORKSPACE : `${DOCKER_WORKSPACE}/${review.cwdLabel.replace(/\\/g, '/')}`;
}

function dockerEnvPairs() {
  return [
    ['PATH', process.env.SHELL_DOCKER_PATH || DOCKER_DEFAULT_PATH],
    ['HOME', '/tmp'],
    ['TMPDIR', '/tmp'],
    ['TMP', '/tmp'],
    ['TEMP', '/tmp'],
    ['LANG', 'C.UTF-8'],
    ['LC_ALL', 'C.UTF-8'],
    ['CI', '1'],
    ['NO_COLOR', '1'],
    ['GIT_TERMINAL_PROMPT', '0'],
    ['GIT_OPTIONAL_LOCKS', '0'],
    ['GIT_CONFIG_NOSYSTEM', '1'],
    ['GIT_CONFIG_COUNT', '1'],
    ['GIT_CONFIG_KEY_0', 'safe.directory'],
    ['GIT_CONFIG_VALUE_0', DOCKER_WORKSPACE],
    ['npm_config_cache', '/tmp/.npm'],
    ['npm_config_fund', 'false'],
    ['npm_config_audit', 'false'],
  ];
}

function dockerCliEnv() {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH || DEFAULT_PATH,
    HOME: process.env.HOME || '',
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  }).filter(([, value]) => value != null && value !== ''));
}

export function buildDockerRunArgs(review) {
  const dockerNetwork = review.docker?.network || 'none';
  const mountWorkspace = review.docker?.mountWorkspace !== false;
  const args = [
    'run',
    '--rm',
    '--pull', dockerPullPolicy(),
    '--network', dockerNetwork,
    '--cpus', dockerCpus(),
    '--memory', dockerMemory(),
    '--pids-limit', dockerPidsLimit(),
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', dockerUser(),
    '--workdir', containerCwd(review),
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
  ];
  if (mountWorkspace) args.push('-v', `${review.root}:${DOCKER_WORKSPACE}:${dockerWorkspaceMode()}`);
  for (const [key, value] of dockerEnvPairs()) args.push('--env', `${key}=${value}`);
  args.push(dockerImage(), review.command, ...review.args);
  return args;
}

export function buildPythonSandboxDockerArgs(code) {
  const args = [
    'run',
    '--rm',
    '--pull', dockerPullPolicy(),
    '--network', 'none',
    '--cpus', dockerCpus(),
    '--memory', dockerMemory(),
    '--pids-limit', dockerPidsLimit(),
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', dockerUser(),
    '--workdir', PYTHON_SANDBOX_WORKDIR,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
  ];
  for (const [key, value] of dockerEnvPairs()) args.push('--env', `${key}=${value}`);
  args.push(dockerImage(), 'python3', '-I', '-B', '-c', code);
  return args;
}

export function redactShellOutput(text = '') {
  let out = String(text || '');
  out = out.replace(/((?:api[-_]?key|access[-_]?key|secret|token|password|credential)\s*[:=]\s*)[^\s'"]+/gi, '$1[REDACTED]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]');
  out = out.replace(/\b(sk-[A-Za-z0-9]{12,})\b/g, 'sk-[REDACTED]');
  out = out.replace(/\b(AKIA[0-9A-Z]{12,})\b/g, 'AKIA[REDACTED]');
  return out;
}

async function runProcessLimited(bin, args, {
  cwd,
  env,
  timeoutMs,
  maxOutputBytes,
  audit,
  sandbox,
  displayName = bin,
} = {}) {
  return new Promise((resolveDone) => {
    let stdout = '';
    let stderr = '';
    let total = 0;
    let overflow = false;
    let settled = false;
    let closed = false;
    let timer = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveDone({
        ...result,
        stdout: redactShellOutput(result.stdout || ''),
        stderr: redactShellOutput(result.stderr || ''),
        audit,
        sandbox,
      });
    };
    const terminate = () => {
      if (closed) return;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!closed) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 1000);
        killTimer.unref();
      }
    };
    const collect = (target, chunk) => {
      const text = chunk.toString();
      total += Buffer.byteLength(text);
      if (total > maxOutputBytes) {
        overflow = true;
        terminate();
      }
      const next = target + text;
      return Buffer.byteLength(next) > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };

    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.on('error', (err) => finish({ ok: false, code: -1, stdout: '', stderr: err.message, truncated: false }));
    child.on('close', (code) => {
      closed = true;
      finish({
        ok: code === 0 && !overflow,
        code,
        stdout,
        stderr: overflow ? `${stderr}\n${displayName} 输出超过上限 ${maxOutputBytes} bytes，进程已终止。`.trim() : stderr,
        truncated: overflow,
      });
    });
    timer = setTimeout(() => {
      terminate();
      finish({
        ok: false,
        code: -1,
        stdout,
        stderr: `${displayName} 执行超时（${timeoutMs}ms）`,
        truncated: overflow,
      });
    }, timeoutMs);
    timer.unref();
  });
}

async function runReviewedLocalShell(review) {
  return runProcessLimited(review.command, review.args, {
    cwd: review.cwd,
    env: sandboxEnv(review.root),
    timeoutMs: review.timeoutMs,
    maxOutputBytes: review.maxOutputBytes,
    audit: { ...review.audit, runner: 'local' },
    sandbox: { runner: 'local', root: review.root, cwd: review.cwdLabel },
    displayName: 'Shell 命令',
  });
}

async function runReviewedDockerShell(review) {
  const dockerArgs = buildDockerRunArgs(review);
  const dockerPrefixEnd = Math.max(0, dockerArgs.length - review.args.length - 2);
  return runProcessLimited(dockerBin(), dockerArgs, {
    cwd: review.root,
    env: dockerCliEnv(),
    timeoutMs: review.timeoutMs,
    maxOutputBytes: review.maxOutputBytes,
    audit: {
      ...review.audit,
      runner: 'docker',
      dockerImage: dockerImage(),
      workspaceMode: dockerWorkspaceMode(),
      workspaceMounted: review.docker?.mountWorkspace !== false,
      network: review.docker?.network || 'none',
      dockerArgsPreview: dockerArgs.slice(0, dockerPrefixEnd).join(' '),
    },
    sandbox: {
      runner: 'docker',
      image: dockerImage(),
      root: review.root,
      cwd: review.cwdLabel,
      workspaceMode: dockerWorkspaceMode(),
      workspaceMounted: review.docker?.mountWorkspace !== false,
      network: review.docker?.network || 'none',
    },
    displayName: 'Docker Shell',
  });
}

async function runReviewedShell(review) {
  return shellDockerEnabled() ? runReviewedDockerShell(review) : runReviewedLocalShell(review);
}

function normalizePythonCode(code) {
  const text = String(code || '');
  const maxChars = clamp(process.env.PYTHON_CODE_MAX_CHARS, 100, 50000, 8000);
  if (!text.trim()) return { ok: false, reason: '缺少 Python 代码' };
  if (text.length > maxChars) return { ok: false, reason: `Python 代码过长（上限 ${maxChars} 字符）` };
  if (PYTHON_CODE_CONTROL_CHAR_RE.test(text)) return { ok: false, reason: 'Python 代码包含非法控制字符' };
  return { ok: true, code: text };
}

export async function executePythonCodeSandbox(code, { purpose = '' } = {}) {
  if (!pythonCodeSandboxAvailable()) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: 'Python 代码沙箱未启用：需要 SHELL_ENABLED=on 且 SHELL_DOCKER_ENABLED=on',
      sandbox: { runner: 'unavailable' },
    };
  }
  const normalized = normalizePythonCode(code);
  if (!normalized.ok) {
    return { ok: false, code: -1, stdout: '', stderr: normalized.reason, sandbox: { runner: 'docker-python' } };
  }
  const timeoutMs = clamp(process.env.PYTHON_CODE_TIMEOUT_MS || process.env.SHELL_TIMEOUT_MS, 1000, 60000, 10000);
  const maxOutputBytes = clamp(process.env.PYTHON_CODE_MAX_OUTPUT_BYTES || process.env.SHELL_MAX_OUTPUT_BYTES, 1024, 200000, 50000);
  const dockerArgs = buildPythonSandboxDockerArgs(normalized.code);
  return runProcessLimited(dockerBin(), dockerArgs, {
    cwd: shellSandboxRoot(),
    env: dockerCliEnv(),
    timeoutMs,
    maxOutputBytes,
    audit: {
      runner: 'docker-python',
      command: 'python3 -I -B -c <code>',
      purpose: String(purpose || '').slice(0, 300),
      dockerImage: dockerImage(),
      timeoutMs,
      maxOutputBytes,
      workspaceMounted: false,
      network: 'none',
    },
    sandbox: {
      runner: 'docker-python',
      image: dockerImage(),
      cwd: PYTHON_SANDBOX_WORKDIR,
      workspaceMounted: false,
      network: 'none',
    },
    displayName: 'Docker Python 沙箱',
  });
}

export async function executeShellCommand(input = {}, opts = {}) {
  const review = opts.review || reviewShellCommand(input);
  if (!review.ok) {
    return { ok: false, code: -1, error: review.reason, stdout: '', stderr: review.reason, audit: review.audit || null };
  }
  return runReviewedShell(review);
}

export async function executeApprovedShellAction(shell = {}) {
  const review = reviewShellCommand(shell);
  if (!review.ok) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `确认后复审失败：${review.reason}`,
      audit: review.audit || null,
      sandbox: { runner: shellDockerEnabled() ? 'docker' : 'local', root: shellSandboxRoot(), cwd: shell.cwd || '.' },
    };
  }
  return runReviewedShell(review);
}

export function shellApprovalPreview(review) {
  const dockerNetwork = review.docker?.network || 'none';
  const workspace = review.docker?.mountWorkspace === false ? 'none' : dockerWorkspaceMode();
  const runner = shellDockerEnabled()
    ? `Docker：${dockerImage()}（network=${dockerNetwork}，workspace=${workspace}，rootfs=read-only）`
    : '本机受限进程';
  return [
    'Shell 命令已通过审核，但需要主人二次确认后才会执行。',
    `命令：${formatShellCommand(review.command, review.args)}`,
    `用途：${review.purpose || '未填写'}`,
    `审核结论：${review.effect === 'read' ? '只读' : '可能产生副作用'} / ${review.risk}（${review.reviewReason}）`,
    `确认原因：${review.audit?.confirmationReason || '安全策略要求确认'}`,
    `执行环境：${runner}`,
    `沙箱目录：${review.root}`,
    `执行目录：${review.cwdLabel}`,
    `超时/输出上限：${review.timeoutMs}ms / ${review.maxOutputBytes} bytes`,
  ].join('\n');
}

export function formatShellResultForUser(action = {}, result = {}) {
  const shell = action.shell || action;
  const command = formatShellCommand(shell.command || '?', shell.args || []);
  const lines = [
    result.ok ? 'Shell 命令已执行。' : 'Shell 命令执行失败。',
    '',
    `命令：\`${command.replace(/`/g, '\\`')}\``,
    `执行环境：${result.sandbox?.runner === 'docker' ? `Docker（${result.sandbox.image || 'unknown'}）` : '本机受限进程'}`,
    `执行目录：${result.sandbox?.cwd || shell.cwd || '.'}`,
    `退出码：${result.code}`,
  ];
  if (result.truncated) lines.push('输出已达到上限并被截断。');
  if (result.error && !result.stderr) lines.push(`错误：${result.error}`);
  if (result.stdout) lines.push('', 'stdout:', '```text', String(result.stdout).slice(0, 5000), '```');
  if (result.stderr) lines.push('', 'stderr:', '```text', String(result.stderr).slice(0, 3000), '```');
  return lines.join('\n');
}

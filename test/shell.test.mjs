import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildApprovedSandboxDockerArgs,
  buildDockerRunArgs,
  buildPythonSandboxDockerArgs,
  executeShellCommand,
  parseSandboxCommandRequest,
  reviewSandboxCommandRequest,
  reviewShellCommand,
} from '../src/shell.mjs';

function withEnv(patch, fn) {
  const old = {};
  for (const key of Object.keys(patch)) old[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

test('Shell 审核器只允许结构化只读命令并拒绝敏感路径', () => {
  withEnv({ SHELL_SANDBOX_ROOT: process.cwd(), SHELL_ALLOW_PROJECT_COMMANDS: undefined, SHELL_DOCKER_ENABLED: undefined }, () => {
    const ls = reviewShellCommand({ command: 'ls', args: ['src'], cwd: '.' });
    assert.equal(ls.ok, true);
    assert.equal(ls.requiresConfirmation, true);
    assert.match(ls.audit.confirmationReason, /本机 Mac 文件系统访问兜底确认/);
    assert.equal(reviewShellCommand({ command: 'bash', args: ['-lc', 'ls'], cwd: '.' }).ok, false);
    assert.match(reviewShellCommand({ command: 'cat', args: ['.env'], cwd: '.' }).reason, /敏感路径/);
    assert.match(reviewShellCommand({ command: 'cat', args: ['../package.json'], cwd: '.' }).reason, /路径穿越/);
    assert.match(reviewShellCommand({ command: 'npm', args: ['test'], cwd: '.' }).reason, /项目脚本默认禁用/);
  });
});

test('Shell 项目脚本必须显式启用且需要二次确认', () => {
  withEnv({ SHELL_SANDBOX_ROOT: process.cwd(), SHELL_ALLOW_PROJECT_COMMANDS: 'on', SHELL_DOCKER_ENABLED: undefined }, () => {
    const review = reviewShellCommand({ command: 'npm', args: ['run', 'check'], cwd: '.', purpose: '验证语法' });
    assert.equal(review.ok, true);
    assert.equal(review.effect, 'write');
    assert.equal(review.requiresConfirmation, true);
  });
});

test('Shell 执行限制在沙箱内并脱敏常见凭证样式', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-test-'));
  writeFileSync(join(dir, 'note.txt'), 'token=abc123\nhello\n');
  try {
    await withEnv({ SHELL_SANDBOX_ROOT: dir, SHELL_ENABLED: 'on', SHELL_DOCKER_ENABLED: undefined }, async () => {
      const result = await executeShellCommand({ command: 'cat', args: ['note.txt'], cwd: '.' });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /token=\[REDACTED\]/);
      assert.match(result.stdout, /hello/);
      assert.match(reviewShellCommand({ command: 'ls', args: [], cwd: '../' }).reason, /路径穿越/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Docker workspace 若配置为 rw，仍会触发本地文件兜底确认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-docker-rw-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_WORKSPACE_MODE: 'rw',
    }, () => {
      const review = reviewShellCommand({ command: 'ls', args: ['.'], cwd: '.' });
      assert.equal(review.ok, true);
      assert.equal(review.requiresConfirmation, true);
      assert.match(review.audit.confirmationReason, /rw 挂载/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Python 代码只允许在 Docker 只读 runner 中执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-python-'));
  try {
    withEnv({ SHELL_SANDBOX_ROOT: dir, SHELL_DOCKER_ENABLED: undefined }, () => {
      assert.match(reviewShellCommand({ command: 'python3', args: ['-c', 'print(1)'], cwd: '.' }).reason, /Docker runner/);
    });
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      const code = 'x = 1\nprint(x)';
      const review = reviewShellCommand({ command: 'python3', args: ['-c', code], cwd: '.' });
      assert.equal(review.ok, true);
      assert.equal(review.requiresConfirmation, false);
      const dockerArgs = buildDockerRunArgs(review);
      assert.equal(dockerArgs.at(-3), 'python3');
      assert.equal(dockerArgs.at(-2), '-c');
      assert.equal(dockerArgs.at(-1), code);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apt 仅允许 Docker 内 download，不允许安装或 sudo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-apt-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      assert.match(reviewShellCommand({ command: 'sudo', args: ['apt', 'install', 'sl'], cwd: '.' }).reason, /高风险|禁用命令/);
      assert.match(reviewShellCommand({ command: 'apt', args: ['install', 'sl'], cwd: '.' }).reason, /仅允许 download/);
      const review = reviewShellCommand({ command: 'apt', args: ['download', 'sl'], cwd: '.' });
      assert.equal(review.ok, true);
      assert.equal(review.requiresConfirmation, false);
      assert.equal(review.audit.dockerNetwork, 'bridge');
      assert.equal(review.audit.workspaceMounted, false);
      const args = buildDockerRunArgs(review);
      assert.equal(args[args.indexOf('--network') + 1], 'bridge');
      assert.equal(args.includes('-v'), false);
      assert.equal(args[args.indexOf('--workdir') + 1], '/tmp');
      assert.equal(args.at(-3), 'apt');
      assert.equal(args.at(-2), 'download');
      assert.equal(args.at(-1), 'sl');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('访客命令审批：sudo apt install 会转为无挂载 Docker 沙箱安装', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-approved-apt-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_ENABLED: 'on',
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      const parsed = parseSandboxCommandRequest('个人飞书 CLI bash sudo apt install neofetch');
      assert.equal(parsed.ok, true);
      assert.equal(parsed.command, 'apt');
      assert.deepEqual(parsed.args, ['install', 'neofetch']);
      assert.equal(parsed.usedSudo, true);

      const review = reviewSandboxCommandRequest({ text: '个人飞书 CLI bash sudo apt install neofetch' });
      assert.equal(review.ok, true);
      assert.equal(review.sandboxMode, 'apt_install');
      assert.deepEqual(review.packages, ['neofetch']);
      assert.equal(review.network, 'bridge');
      assert.equal(review.readOnlyRootfs, false);
      assert.equal(review.action.command, 'apt-get');
      assert.deepEqual(review.action.args, ['install', 'neofetch']);

      const args = buildApprovedSandboxDockerArgs(review);
      assert.equal(args[args.indexOf('--network') + 1], 'bridge');
      assert.equal(args.includes('-v'), false);
      assert.equal(args.includes('--read-only'), false);
      assert.equal(args.includes('--cap-drop'), false);
      assert.equal(args[args.indexOf('--user') + 1], '0:0');
      assert.equal(args.at(-3), 'sh');
      assert.equal(args.at(-2), '-lc');
      assert.match(args.at(-1), /apt-get update/);
      assert.match(args.at(-1), /apt-get install -y --no-install-recommends neofetch/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('访客命令审批：无 cue 的普通英文不误判，复杂 shell 语法不进审批', () => {
  withEnv({ SHELL_ENABLED: 'on', SHELL_DOCKER_ENABLED: 'on' }, () => {
    assert.equal(parseSandboxCommandRequest('hello world').ok, false);
    assert.equal(reviewSandboxCommandRequest({ text: 'hello world' }).kind, 'none');
    const complex = parseSandboxCommandRequest('命令：ls | cat');
    assert.equal(complex.ok, false);
    assert.equal(complex.kind, 'unsupported');
    assert.match(complex.reason, /管道|重定向|连接符/);
  });
  withEnv({ SHELL_ENABLED: undefined, SHELL_DOCKER_ENABLED: undefined }, () => {
    assert.equal(reviewSandboxCommandRequest({ text: 'hello world' }).kind, 'none');
  });
});

test('Docker 沙箱通用命令：ping 可确认执行，高风险删除命令拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-generic-docker-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_ENABLED: 'on',
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      const ping = reviewShellCommand({ command: 'ping', args: ['example.com'], cwd: '.' });
      assert.equal(ping.ok, true);
      assert.equal(ping.requiresConfirmation, true);
      assert.deepEqual(ping.args, ['-c', '4', 'example.com']);
      assert.equal(ping.audit.dockerNetwork, 'bridge');
      assert.equal(ping.audit.workspaceMounted, false);
      const pingArgs = buildDockerRunArgs(ping);
      assert.equal(pingArgs[pingArgs.indexOf('--network') + 1], 'bridge');
      assert.equal(pingArgs.includes('-v'), false);
      assert.equal(pingArgs.includes('--cap-drop'), false);
      assert.equal(pingArgs[pingArgs.indexOf('--user') + 1], '0:0');
      assert.equal(pingArgs.at(-4), 'ping');
      assert.deepEqual(pingArgs.slice(-3), ['-c', '4', 'example.com']);

      const visitorPing = reviewSandboxCommandRequest({ text: 'ping example.com' });
      assert.equal(visitorPing.ok, true);
      assert.equal(visitorPing.network, 'bridge');
      assert.deepEqual(visitorPing.action.args, ['-c', '4', 'example.com']);

      const whoami = reviewShellCommand({ command: 'whoami', args: [], cwd: '.' });
      assert.equal(whoami.ok, true);
      assert.equal(whoami.requiresConfirmation, true);
      assert.equal(whoami.audit.workspaceMounted, false);
      assert.equal(buildDockerRunArgs(whoami).includes('-v'), false);

      const node = reviewShellCommand({ command: 'node', args: ['--version'], cwd: '.' });
      assert.equal(node.ok, true);
      assert.equal(node.requiresConfirmation, true);
      assert.equal(node.audit.workspaceMounted, false);

      assert.equal(reviewSandboxCommandRequest({ text: '命令：whoami' }).ok, true);
      assert.match(reviewSandboxCommandRequest({ text: '命令：rm -rf tmp' }).reason, /高风险|删除|写入/);
      assert.match(reviewShellCommand({ command: 'rm', args: ['tmp'], cwd: '.' }).reason, /高风险|禁用命令|写入/);
      assert.match(reviewShellCommand({ command: 'ping', args: ['127.0.0.1'], cwd: '.' }).reason, /内网|本地/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('curl/wget 仅允许 Docker 内公开 URL 下载到容器 tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-download-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      const curl = reviewShellCommand({ command: 'curl', args: ['-fL', '-O', 'https://example.com/file.tar.gz'], cwd: '.' });
      assert.equal(curl.ok, true);
      assert.equal(curl.requiresConfirmation, false);
      assert.equal(curl.audit.dockerNetwork, 'bridge');
      assert.equal(curl.audit.workspaceMounted, false);
      const curlArgs = buildDockerRunArgs(curl);
      assert.equal(curlArgs[curlArgs.indexOf('--network') + 1], 'bridge');
      assert.equal(curlArgs.includes('-v'), false);
      assert.equal(curlArgs[curlArgs.indexOf('--workdir') + 1], '/tmp');
      assert.equal(curlArgs.at(-4), 'curl');
      assert.equal(curlArgs.at(-3), '-fL');
      assert.equal(curlArgs.at(-2), '-O');
      assert.equal(curlArgs.at(-1), 'https://example.com/file.tar.gz');

      const wget = reviewShellCommand({ command: 'wget', args: ['-O', 'file.tgz', 'https://example.com/file.tgz'], cwd: '.' });
      assert.equal(wget.ok, true);
      assert.equal(wget.audit.dockerNetwork, 'bridge');
      assert.equal(wget.audit.workspaceMounted, false);

      assert.match(reviewShellCommand({ command: 'curl', args: ['http://127.0.0.1:8080/x'], cwd: '.' }).reason, /内网|本地/);
      assert.match(reviewShellCommand({ command: 'wget', args: ['--header=Authorization: Bearer x', 'https://example.com/a'], cwd: '.' }).reason, /allowlist/);
      assert.match(reviewShellCommand({ command: 'curl', args: ['-o', '../x', 'https://example.com/a'], cwd: '.' }).reason, /路径穿越|不安全/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('访客 Python 沙箱 Docker 参数不挂载 workspace', () => {
  withEnv({
    SHELL_DOCKER_ENABLED: 'on',
    SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
  }, () => {
    const args = buildPythonSandboxDockerArgs('print(123)');
    assert.ok(args.includes('--network'));
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop'));
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(args.includes('-v'), false);
    assert.equal(args.includes('/workspace'), false);
    assert.equal(args.at(-5), 'python3');
    assert.equal(args.at(-4), '-I');
    assert.equal(args.at(-3), '-B');
    assert.equal(args.at(-2), '-c');
    assert.equal(args.at(-1), 'print(123)');
  });
});

test('Docker runner 参数默认禁网、只读、降权并限制资源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-shell-docker-'));
  try {
    withEnv({
      SHELL_SANDBOX_ROOT: dir,
      SHELL_DOCKER_ENABLED: 'on',
      SHELL_DOCKER_IMAGE: 'larkbot-shell-sandbox:test',
      SHELL_DOCKER_WORKSPACE_MODE: undefined,
      SHELL_CONFIRM_ALL: undefined,
    }, () => {
      const review = reviewShellCommand({ command: 'ls', args: ['.'], cwd: '.' });
      assert.equal(review.ok, true);
      assert.equal(review.audit.runner, 'docker');
      assert.equal(review.requiresConfirmation, false);
      const args = buildDockerRunArgs(review);
      assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
      assert.ok(args.includes('--network'));
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.ok(args.includes('--read-only'));
      assert.ok(args.includes('--cap-drop'));
      assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
      assert.ok(args.includes('--security-opt'));
      assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
      assert.ok(args.includes('--pids-limit'));
      assert.equal(args[args.indexOf('--pids-limit') + 1], '128');
      assert.ok(args.includes('-v'));
      assert.equal(args[args.indexOf('-v') + 1], `${dir}:/workspace:ro`);
      assert.ok(args.includes('--tmpfs'));
      assert.match(args[args.indexOf('--tmpfs') + 1], /^\/tmp:rw,noexec,nosuid/);
      assert.equal(args.at(-3), 'larkbot-shell-sandbox:test');
      assert.equal(args.at(-2), 'ls');
      assert.equal(args.at(-1), '.');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

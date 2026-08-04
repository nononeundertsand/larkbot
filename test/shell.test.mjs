import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildDockerRunArgs,
  buildPythonSandboxDockerArgs,
  executeShellCommand,
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
      assert.match(reviewShellCommand({ command: 'sudo', args: ['apt', 'install', 'sl'], cwd: '.' }).reason, /禁用命令/);
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

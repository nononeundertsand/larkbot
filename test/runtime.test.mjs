import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalStore } from '../src/approval.mjs';

test('写审批绑定具体会话，不能跨群确认', () => {
  const store = new ApprovalStore({ ttlMs: 10000 });
  const action = { id: 'a1', toolName: 'send_message', args: ['im', '+messages-send'], preview: '发送消息', confirmToken: 'ABC123' };
  store.register('g:group-a:owner', action);
  assert.equal(store.resolve('g:group-b:owner', '确认 ABC123', { isOwner: true }).kind, 'none');
  assert.equal(store.size(), 1);
  assert.equal(store.resolve('g:group-a:owner', '确认', { isOwner: true }).kind, 'mismatch');
  assert.equal(store.size(), 1);
  const result = store.resolve('g:group-a:owner', '确认 ABC123', { isOwner: true });
  assert.equal(result.kind, 'execute');
  assert.equal(result.action.id, 'a1');
  assert.equal(store.size(), 0);
});

test('模糊同意词不会触发写操作，新请求会作废旧审批', () => {
  const store = new ApprovalStore({ ttlMs: 10000 });
  store.register('p:owner', { id: 'a2', args: ['task', '+create'], preview: '建任务' });
  assert.equal(store.resolve('p:owner', '好的', { isOwner: true }).kind, 'superseded');
  assert.equal(store.size(), 0);
});

test('审批状态机支持 Shell executor 动作', () => {
  const store = new ApprovalStore({ ttlMs: 10000 });
  store.register('p:owner', {
    id: 's1',
    toolName: 'run_shell_command',
    executor: 'shell',
    shell: { command: 'ls', args: ['src'], cwd: '.', purpose: '查看源码目录' },
    preview: '执行 Shell',
    confirmToken: 'SHELL1',
  });
  const result = store.resolve('p:owner', '确认 SHELL1', { isOwner: true });
  assert.equal(result.kind, 'execute');
  assert.equal(result.action.executor, 'shell');
  assert.equal(result.action.shell.command, 'ls');
});

test('OWNER_OPEN_ID 为空时可从 lark-cli user 登录态自动发现主人', async () => {
  const oldOpenId = process.env.OWNER_OPEN_ID;
  const oldName = process.env.OWNER_NAME;
  const oldAuto = process.env.OWNER_AUTO_DISCOVER;
  delete process.env.OWNER_OPEN_ID;
  delete process.env.OWNER_NAME;
  process.env.OWNER_AUTO_DISCOVER = 'on';
  try {
    const owner = await import(`../src/owner.mjs?auto=${Date.now()}`);
    await owner.initOwnerIdentity(async () => ({
      code: 0,
      json: {
        data: {
          identities: {
            user: { openId: 'ou_auto_owner', userName: '自动主人' },
          },
        },
      },
    }), { logger: { log() {}, warn() {} } });
    assert.equal(owner.getOwnerOpenId(), 'ou_auto_owner');
    assert.equal(owner.getOwnerName(), '自动主人');
    assert.equal(owner.isOwnerSender('ou_auto_owner'), true);
  } finally {
    if (oldOpenId === undefined) delete process.env.OWNER_OPEN_ID;
    else process.env.OWNER_OPEN_ID = oldOpenId;
    if (oldName === undefined) delete process.env.OWNER_NAME;
    else process.env.OWNER_NAME = oldName;
    if (oldAuto === undefined) delete process.env.OWNER_AUTO_DISCOVER;
    else process.env.OWNER_AUTO_DISCOVER = oldAuto;
  }
});

test('飞书 missing_scope 错误会格式化为可行动提示', async () => {
  const { formatLarkFailureForTool } = await import('../src/lark-errors.mjs');
  const result = formatLarkFailureForTool({
    code: 1,
    err: JSON.stringify({
      ok: false,
      error: {
        type: 'authorization',
        subtype: 'missing_scope',
        message: 'missing scope',
        missing_scopes: ['calendar:calendar.event:read'],
        hint: 'run auth login',
      },
    }),
  });
  assert.match(result.error, /缺少飞书 user 授权/);
  assert.deepEqual(result.larkError.missingScopes, ['calendar:calendar.event:read']);
});

test('lark-cli 子进程有超时保护', async () => {
  process.env.LARK_CLI_BIN = '/bin/sh';
  process.env.LARK_TIMEOUT_MS = '100';
  const { runLark } = await import(`../src/lark.mjs?timeout=${Date.now()}`);
  const started = Date.now();
  const result = await runLark(['-c', 'sleep 1']);
  assert.equal(result.code, -1);
  assert.match(result.err, /超时/);
  assert.ok(Date.now() - started < 800);
});

test('记忆首轮即创建私有 profile，场景文件使用原子写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-memory-test-'));
  process.env.MEMORY_DATA_DIR = dir;
  process.env.MEMORY_EXTRACT_EVERY = '1';
  delete process.env.LLM_API_KEY;
  const memory = await import(`../src/memory.mjs?dir=${Date.now()}`);
  const key = memory.sessionKey({
    chatType: 'p2p',
    senderId: 'ou_test_user',
    senderName: '测试用户',
    senderEmail: 'test@example.com',
  });
  try {
    memory.appendTurn(key, '你好', '你好', { persist: true });
    await memory.maintainMemory(key);
    const userDir = join(dir, '测试用户_est_user');
    const profile = JSON.parse(readFileSync(join(userDir, 'profile.json'), 'utf8'));
    assert.equal(profile.openId, 'ou_test_user');
    assert.equal(JSON.parse(readFileSync(join(userDir, 'p2p.json'), 'utf8')).scene, 'p2p');
    assert.equal(statSync(join(userDir, 'profile.json')).mode & 0o077, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构化长期记忆按相关性检索并遗忘过期项', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-structured-memory-'));
  process.env.MEMORY_DATA_DIR = dir;
  process.env.MEMORY_CONTEXT_BUDGET_CHARS = '1200';
  const senderId = 'ou_struct_user';
  const userDir = join(dir, '记忆用户_uct_user');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'p2p.json'), JSON.stringify({
    scene: 'p2p',
    chatType: 'p2p',
    summary: '旧摘要'.repeat(200),
    facts: {},
    memories: [
      {
        id: 'm_relevant',
        scope: 'p2p',
        type: 'preference',
        source: 'user',
        key: 'feedback_style',
        content: '反馈风格: 用户偏好直接严格的系统评估',
        confidence: 0.95,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        useCount: 0,
      },
      {
        id: 'm_irrelevant',
        scope: 'p2p',
        type: 'preference',
        source: 'user',
        key: 'music',
        content: '音乐偏好: 用户喜欢爵士乐',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        useCount: 0,
      },
      {
        id: 'm_expired',
        scope: 'p2p',
        type: 'temporary',
        source: 'user',
        key: 'temp',
        content: '临时事项: 今天下午买咖啡',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
        useCount: 0,
      },
    ],
    messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `很长的历史消息 ${i} ` + 'x'.repeat(200) })),
    updatedAt: new Date().toISOString(),
  }));

  try {
    const memory = await import(`../src/memory.mjs?structured=${Date.now()}`);
    const key = memory.sessionKey({
      chatType: 'p2p',
      senderId,
      senderName: '记忆用户',
    });
    const ctx = memory.buildContext(key, {
      persist: true,
      query: '请直接严格评估这个系统',
      budgetChars: 1200,
    });
    assert.match(ctx.memoryBrief, /直接严格/);
    assert.doesNotMatch(ctx.memoryBrief, /爵士乐/);
    assert.doesNotMatch(ctx.memoryBrief, /咖啡/);
    assert.ok(ctx.summary.length < 700);
    assert.ok(ctx.history.length < 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构化记忆加载时清洗重复 key 前缀并合并同 key 记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-memory-prefix-'));
  process.env.MEMORY_DATA_DIR = dir;
  const groupDir = join(dir, 'groups');
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(join(groupDir, 'group_oc_prefix.json'), JSON.stringify({
    chatId: 'oc_prefix',
    summary: '',
    facts: {
      member_roles: 'member_roles: member_roles: {"甲":"Owner"}',
    },
    memories: [
      {
        id: 'm1',
        scope: 'group',
        type: 'relationship',
        source: 'llm',
        key: 'member_roles',
        content: 'member_roles: {"甲":"Owner"}',
        confidence: 0.8,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        useCount: 0,
      },
      {
        id: 'm2',
        scope: 'group',
        type: 'preference',
        source: 'llm',
        key: 'member_roles',
        content: 'member_roles: member_roles: {"甲":"Owner","乙":"Tester"}',
        confidence: 0.8,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        expiresAt: null,
        useCount: 0,
      },
    ],
    updatedAt: new Date().toISOString(),
  }));

  try {
    const memory = await import(`../src/memory.mjs?prefix=${Date.now()}`);
    const ctx = memory.buildGroupContext('oc_prefix', {
      persist: true,
      query: 'member_roles',
      budgetChars: 2000,
    });
    assert.equal(ctx.groupMemories.filter((m) => m.key === 'member_roles').length, 1);
    assert.equal(ctx.groupFacts.member_roles, '{"甲":"Owner","乙":"Tester"}');
    assert.doesNotMatch(ctx.groupMemoryBrief, /member_roles:\s*member_roles/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

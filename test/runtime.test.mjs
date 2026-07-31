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

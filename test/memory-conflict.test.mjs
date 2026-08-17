import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const memoryModule = await import(`../src/memory.mjs?conflict=${Date.now()}`);
const { __testing } = memoryModule;

function memory(overrides = {}) {
  return {
    id: overrides.id || `m_${Math.random().toString(16).slice(2)}`,
    scope: 'p2p',
    type: 'fact',
    source: 'llm',
    key: 'office',
    content: '用户办公地点在北京',
    confidence: 0.8,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    useCount: 0,
    ...overrides,
  };
}

function edge(overrides = {}) {
  return {
    id: overrides.id || `e_${Math.random().toString(16).slice(2)}`,
    scope: 'p2p',
    subject: '用户',
    predicate: '办公地点',
    object: '北京',
    confidence: 0.8,
    origin: 'llm',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    useCount: 0,
    ...overrides,
  };
}

test('同 key 不同值会标记为 conflicted 并保留双方证据', () => {
  const merged = __testing.mergeMemories([
    memory({ id: 'm_old', content: '用户办公地点在北京' }),
  ], [
    memory({ id: 'm_new', content: '用户办公地点在上海', updatedAt: '2026-01-02T00:00:00.000Z' }),
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(new Set(merged.map((m) => m.status)), new Set(['conflicted']));
  assert.deepEqual(merged.find((m) => m.id === 'm_old').conflictWith, ['m_new']);
  assert.deepEqual(merged.find((m) => m.id === 'm_new').conflictWith, ['m_old']);
});

test('新 JSON 记忆包含旧 JSON 时旧记忆进入 superseded，新记忆保持 active', () => {
  const merged = __testing.mergeMemories([
    memory({
      id: 'm_old',
      key: 'member_roles',
      type: 'relationship',
      content: '{"甲":"Owner"}',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  ], [
    memory({
      id: 'm_new',
      key: 'member_roles',
      type: 'relationship',
      content: '{"甲":"Owner","乙":"Tester"}',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
  ]);

  assert.equal(merged.find((m) => m.id === 'm_new').status, 'active');
  const old = merged.find((m) => m.id === 'm_old');
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, 'm_new');
});

test('同 subject/predicate 多 object 的图谱边会标记 conflicted，别名边不误判', () => {
  const merged = __testing.mergeGraphEdges([
    edge({ id: 'e_old', object: '北京' }),
    edge({ id: 'e_alias_a', subject: '徐玉峰', predicate: '别名', object: '许慎' }),
  ], [
    edge({ id: 'e_new', object: '上海', updatedAt: '2026-01-02T00:00:00.000Z' }),
    edge({ id: 'e_alias_b', subject: '徐玉峰', predicate: '别名', object: '徐老师' }),
  ]);

  assert.equal(merged.find((e) => e.id === 'e_old').status, 'conflicted');
  assert.equal(merged.find((e) => e.id === 'e_new').status, 'conflicted');
  assert.equal(merged.find((e) => e.id === 'e_alias_a').status, 'active');
  assert.equal(merged.find((e) => e.id === 'e_alias_b').status, 'active');
});

test('conflicted 记忆和图谱边不会注入上下文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-memory-conflict-ctx-'));
  process.env.MEMORY_DATA_DIR = dir;
  const userDir = join(dir, '冲突用户_lictuser');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'p2p.json'), JSON.stringify({
    scene: 'p2p',
    chatType: 'p2p',
    summary: '',
    facts: {},
    memories: [
      memory({ id: 'm_old', content: '用户办公地点在北京' }),
      memory({ id: 'm_new', content: '用户办公地点在上海', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ],
    graph: {
      edges: [
        edge({ id: 'e_old', object: '北京' }),
        edge({ id: 'e_new', object: '上海', updatedAt: '2026-01-02T00:00:00.000Z' }),
      ],
    },
    updatedAt: new Date().toISOString(),
  }));

  try {
    const fresh = await import(`../src/memory.mjs?conflictctx=${Date.now()}`);
    const key = fresh.sessionKey({
      chatType: 'p2p',
      senderId: 'ou_conflictuser',
      senderName: '冲突用户',
    });
    const ctx = fresh.buildContext(key, {
      persist: true,
      query: '办公地点在哪里',
      budgetChars: 2000,
    });
    assert.doesNotMatch(ctx.memoryBrief, /北京|上海/);
    assert.doesNotMatch(ctx.graphBrief, /北京|上海/);
    assert.equal(ctx.memories.length, 0);
    assert.equal(ctx.graphEdges.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

const { __testing } = await import(`../src/memory.mjs?retrieval=${Date.now()}`);

function memory(overrides = {}) {
  return {
    id: overrides.id || `m_${Math.random().toString(16).slice(2)}`,
    scope: 'p2p',
    type: 'fact',
    source: 'llm',
    key: 'note',
    content: '',
    confidence: 0.7,
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
    subject: '',
    predicate: '',
    object: '',
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

test('Hybrid Retrieval 使用 BM25 选中部分关键词匹配的结构化记忆', () => {
  const selected = __testing.selectRelevantMemories([
    memory({
      id: 'm_noise_high_conf',
      key: 'daily_preference',
      content: '用户喜欢咖啡、爵士乐和安静办公环境',
      confidence: 0.99,
    }),
    memory({
      id: 'm_relevant',
      type: 'preference',
      key: 'memory_governance',
      content: '记忆冲突治理使用 conflicted 和 superseded 状态保留审计证据',
      confidence: 0.72,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    memory({
      id: 'm_common',
      type: 'preference',
      key: 'memory_general',
      content: '记忆系统包含摘要、事实和图谱',
      confidence: 0.9,
    }),
  ], '冲突治理审计', { limit: 2, budgetChars: 1200 });

  assert.equal(selected[0].id, 'm_relevant');
  assert.equal(selected.some((item) => item.id === 'm_noise_high_conf'), false);
});

test('Hybrid Graph Retrieval 召回直接命中和相邻边，并排除无关边', () => {
  const selected = __testing.selectRelevantGraphEdges([
    edge({
      id: 'e_direct',
      subject: '知识图谱召回',
      predicate: '采用',
      object: 'BM25混合排序',
      description: '第一阶段本地检索实现',
    }),
    edge({
      id: 'e_neighbor',
      subject: 'BM25混合排序',
      predicate: '排序因素',
      object: 'lexical score graph distance recency confidence useCount',
    }),
    edge({
      id: 'e_noise',
      subject: '茶水间',
      predicate: '摆放',
      object: '咖啡机',
      confidence: 0.99,
    }),
  ], '知识图谱召回怎么排序', { limit: 4, budgetChars: 2000, hops: 1 });

  const ids = selected.map((item) => item.id);
  assert.deepEqual(ids.slice(0, 2), ['e_direct', 'e_neighbor']);
  assert.equal(ids.includes('e_noise'), false);
});

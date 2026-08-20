import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKFLOW_SCHEMA_VERSION,
  appendWorkflowProgress,
  createArtifact,
  createCitation,
  createWorkflowV2,
  markWorkflowCanceled,
  markWorkflowRetry,
  normalizeWorkflow,
  transitionWorkflowStatus,
  upsertWorkflowArtifact,
  upsertWorkflowCitation,
} from '../src/workflow-schema.mjs';

test('workflow v2 schema 创建时包含 artifact/citation/progress 基础字段', () => {
  const workflow = createWorkflowV2({
    type: 'doc_report',
    title: '总结文档',
    userGoal: '帮我总结这些文档',
    plan: { summary: '读取并总结', assumptions: ['文档可访问'], missingInputs: ['文档链接'] },
    steps: [{ id: 'read', type: 'tool', title: '读取文档' }],
  });

  assert.equal(workflow.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.equal(workflow.type, 'doc_report');
  assert.equal(workflow.userGoal, '帮我总结这些文档');
  assert.deepEqual(workflow.plan.missingInputs, ['文档链接']);
  assert.deepEqual(workflow.artifacts, {});
  assert.deepEqual(workflow.citations, {});
  assert.equal(workflow.steps[0].artifactIds.length, 0);
  assert.equal(workflow.steps[0].citationIds.length, 0);
  assert.equal(workflow.progressEvents[0].type, 'created');
});

test('workflow v1 数据可规范化为 v2 并保留原字段', () => {
  const legacy = {
    schemaVersion: 1,
    workflowId: 'wf_old',
    title: '旧任务',
    status: 'waiting_confirmation',
    steps: [{ id: 'send', type: 'send', status: 'waiting_confirmation', requiresConfirmation: true }],
    currentStep: 0,
    requiresConfirmation: true,
    resumeToken: 'ABC',
    sessionKey: 'p:owner',
  };
  const workflow = normalizeWorkflow(legacy);
  assert.equal(workflow.schemaVersion, 2);
  assert.equal(workflow.workflowId, 'wf_old');
  assert.equal(workflow.steps[0].id, 'send');
  assert.equal(workflow.resumeToken, 'ABC');
  assert.equal(workflow.progressEvents[0].message, 'workflow v1 migrated to v2');
});

test('artifact 和 citation 可写入 workflow', () => {
  let workflow = createWorkflowV2({ steps: [{ id: 'write', type: 'transform' }] });
  const citation = createCitation({ id: 'c1', type: 'doc', title: '设计文档', sourceId: 'doc_x', quote: '关键段落' });
  const artifact = createArtifact({ id: 'a1', type: 'report', title: '报告草稿', content: '结论', citationIds: ['c1'], createdByStepId: 'write' });

  workflow = upsertWorkflowCitation(workflow, citation);
  workflow = upsertWorkflowArtifact(workflow, artifact);

  assert.equal(workflow.citations.c1.quote, '关键段落');
  assert.equal(workflow.artifacts.a1.type, 'report');
  assert.deepEqual(workflow.artifacts.a1.citationIds, ['c1']);
});

test('workflow 状态转换、取消和重试规则可校验', () => {
  let workflow = createWorkflowV2({
    status: 'pending',
    steps: [{ id: 'read', type: 'tool', status: 'failed', error: 'timeout' }],
  });
  workflow = transitionWorkflowStatus(workflow, 'running', { message: '开始执行' });
  assert.equal(workflow.status, 'running');
  assert.equal(workflow.progressEvents.at(-1).type, 'started');

  workflow = markWorkflowRetry(workflow, 'read', { reason: '重试读取' });
  assert.equal(workflow.status, 'running');
  assert.equal(workflow.steps[0].status, 'pending');
  assert.equal(workflow.steps[0].retryCount, 1);
  assert.equal(workflow.progressEvents.at(-1).type, 'retried');

  workflow = markWorkflowCanceled(workflow, '用户取消');
  assert.equal(workflow.status, 'canceled');
  assert.equal(workflow.progressEvents.at(-1).type, 'canceled');
  assert.throws(() => transitionWorkflowStatus(workflow, 'running'), /不允许/);
});

test('progress event 会按追加顺序保留', () => {
  let workflow = createWorkflowV2();
  workflow = appendWorkflowProgress(workflow, { type: 'started', message: '开始' });
  workflow = appendWorkflowProgress(workflow, { type: 'step_started', stepId: 's1', message: '步骤开始' });
  assert.equal(workflow.progressEvents.at(-2).message, '开始');
  assert.equal(workflow.progressEvents.at(-1).stepId, 's1');
});

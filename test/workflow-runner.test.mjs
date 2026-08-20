import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RuntimeStateStore } from '../src/state-store.mjs';
import { createWorkflow } from '../src/workflow.mjs';
import { createWorkflowRunner } from '../src/workflow-runner.mjs';

test('workflow runner 可执行 fake plan/tool/transform/verify/send 并持久化进度', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-workflow-runner-'));
  const file = join(dir, 'state.json');
  try {
    const stateStore = new RuntimeStateStore({ file });
    const events = [];
    const workflow = createWorkflow({
      title: 'fake workflow',
      steps: [
        { id: 'plan', type: 'plan', title: '规划', input: { ok: true } },
        { id: 'tool', type: 'tool', title: '读材料', input: { source: 'doc' } },
        { id: 'transform', type: 'transform', title: '整理报告' },
        { id: 'verify', type: 'verify', title: '检查引用' },
        { id: 'send', type: 'send', title: '发送结果' },
      ],
    });
    stateStore.saveWorkflow(workflow);

    const runner = createWorkflowRunner({
      stateStore,
      progressSink: (event) => { events.push(event); },
      handlers: {
        tool: async () => ({
          output: { text: 'doc content' },
          citations: [{ id: 'c_doc', type: 'doc', title: '文档', sourceId: 'doc_1', quote: 'doc content' }],
          artifacts: [{ id: 'a_doc', type: 'text', title: '材料摘录', content: 'doc content', citationIds: ['c_doc'] }],
        }),
        transform: async ({ workflow: wf }) => ({ output: { artifactCount: Object.keys(wf.artifacts).length } }),
        verify: async () => ({ output: { ok: true } }),
        send: async () => ({ output: { sent: true } }),
      },
    });

    const result = await runner.run(workflow.workflowId);
    assert.equal(result.status, 'completed');
    assert.equal(result.workflow.artifacts.a_doc.title, '材料摘录');
    assert.equal(result.workflow.citations.c_doc.type, 'doc');
    assert.ok(events.some((event) => event.type === 'step_started' && event.stepId === 'tool'));
    assert.ok(events.some((event) => event.type === 'completed'));

    const restored = new RuntimeStateStore({ file }).getWorkflow(workflow.workflowId);
    assert.equal(restored.status, 'completed');
    assert.equal(restored.steps.every((step) => step.status === 'completed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runner 遇到 confirm step 会暂停，确认后继续执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-workflow-confirm-'));
  const file = join(dir, 'state.json');
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createWorkflow({
      title: '确认发送',
      steps: [
        { id: 'draft', type: 'transform', title: '生成草稿', input: { body: '草稿' } },
        { id: 'confirm', type: 'confirm', title: '确认发送', input: { reason: '是否发送报告', actionId: 'send_report' } },
        { id: 'send', type: 'send', title: '发送报告' },
      ],
    });
    stateStore.saveWorkflow(workflow);
    const handlers = {
      transform: async ({ step }) => ({ output: step.input }),
      send: async () => ({ output: { sent: true } }),
    };
    const runner = createWorkflowRunner({ stateStore, handlers });

    const waiting = await runner.run(workflow.workflowId);
    assert.equal(waiting.status, 'waiting_confirmation');
    assert.equal(waiting.workflow.confirmation.actionId, 'send_report');
    assert.equal(waiting.workflow.steps[1].status, 'waiting_confirmation');

    const freshRunner = createWorkflowRunner({ stateStore: new RuntimeStateStore({ file }), handlers });
    const stillWaiting = await freshRunner.run(workflow.workflowId);
    assert.equal(stillWaiting.status, 'waiting_confirmation');

    const confirmed = await freshRunner.confirm(workflow.workflowId, { token: stillWaiting.workflow.resumeToken });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.workflow.steps[1].output.confirmed, true);
    assert.equal(confirmed.workflow.steps[2].output.sent, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runner 支持失败步骤重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-workflow-retry-'));
  const file = join(dir, 'state.json');
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createWorkflow({
      title: '失败重试',
      steps: [{ id: 'tool', type: 'tool', title: '不稳定工具' }],
    });
    stateStore.saveWorkflow(workflow);
    let calls = 0;
    const runner = createWorkflowRunner({
      stateStore,
      handlers: {
        tool: async () => {
          calls += 1;
          if (calls === 1) throw new Error('临时失败');
          return { output: { ok: true } };
        },
      },
    });

    const failed = await runner.run(workflow.workflowId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.workflow.steps[0].status, 'failed');

    const retried = await runner.retry(workflow.workflowId, 'tool', { reason: '重试' });
    assert.equal(retried.status, 'completed');
    assert.equal(retried.workflow.steps[0].retryCount, 1);
    assert.deepEqual(retried.workflow.steps[0].output, { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runner 支持取消 waiting workflow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-workflow-cancel-'));
  const file = join(dir, 'state.json');
  try {
    const stateStore = new RuntimeStateStore({ file });
    const workflow = createWorkflow({
      title: '取消任务',
      steps: [{ id: 'confirm', type: 'confirm', title: '确认' }],
    });
    stateStore.saveWorkflow(workflow);
    const runner = createWorkflowRunner({ stateStore });
    const waiting = await runner.run(workflow.workflowId);
    assert.equal(waiting.status, 'waiting_confirmation');

    const canceled = await runner.cancel(workflow.workflowId, '用户取消');
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.workflow.progressEvents.at(-1).type, 'canceled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, getToolDescriptors, getToolSchemas } from '../src/tools.mjs';
import { validateToolArgs } from '../src/tool-schema.mjs';

test('工具参数校验拒绝缺失必填、未知参数和错误类型', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  };
  const result = validateToolArgs(schema, { query: '', limit: '5', extra: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_tool_arguments');
  assert.ok(result.error.issues.some((issue) => issue.code === 'required' && issue.path === '$.query'));
  assert.ok(result.error.issues.some((issue) => issue.code === 'type' && issue.path === '$.limit'));
  assert.ok(result.error.issues.some((issue) => issue.code === 'additionalProperties' && issue.path === '$.extra'));
});

test('executeTool 在执行前拒绝非法 URL 参数并返回兼容错误', async () => {
  const result = await executeTool('web_fetch', { url: 'file:///etc/passwd' }, { isOwner: false });
  assert.equal(result.errorCode, 'invalid_tool_arguments');
  assert.match(result.error, /工具参数校验失败/);
  assert.ok(result.issues.some((issue) => issue.path === '$.url'));
});

test('executeTool 可返回统一 envelope，默认仍兼容旧结果', async () => {
  const envelope = await executeTool('list_models', {}, { isOwner: true }, { envelope: true });
  assert.equal(envelope.ok, true);
  assert.ok(Array.isArray(envelope.data.models));
  assert.equal(envelope.trace.toolName, 'list_models');

  const legacy = await executeTool('list_models', {}, { isOwner: true });
  assert.ok(Array.isArray(legacy.models));
});

test('工具 descriptor 统一暴露 metadata，LLM schema 保持 function calling 形状', () => {
  const descriptors = getToolDescriptors({ isOwner: true });
  const sendMessage = descriptors.find((item) => item.name === 'send_message');
  assert.ok(sendMessage);
  assert.ok(sendMessage.inputSchema.properties.to_user_email);
  assert.equal(sendMessage.policy.effect, 'write');
  assert.equal(sendMessage.outputSchema.properties.ok.type, 'boolean');
  assert.ok(Array.isArray(sendMessage.examples));

  const schema = getToolSchemas({ isOwner: true }).find((item) => item.function.name === 'send_message');
  assert.equal(schema.type, 'function');
  assert.equal(schema.function.parameters, sendMessage.inputSchema);
});

test('关键工具边界校验覆盖邮箱、日期和 Shell args 类型', async () => {
  const mail = await executeTool('mail_send', {
    to: 'not-an-email',
    subject: 'Hello',
    body: 'Body',
  }, { isOwner: true });
  assert.equal(mail.errorCode, 'invalid_tool_arguments');
  assert.ok(mail.issues.some((issue) => issue.path === '$.to'));

  const calendar = await executeTool('calendar_create', {
    summary: '开会',
    start: '2026-08-18 10:00',
    end: '2026-08-18T11:00+08:00',
  }, { isOwner: true });
  assert.equal(calendar.errorCode, 'invalid_tool_arguments');
  assert.ok(calendar.issues.some((issue) => issue.path === '$.start'));

  const oldShell = process.env.SHELL_ENABLED;
  try {
    process.env.SHELL_ENABLED = 'on';
    const shell = await executeTool('run_shell_command', {
      command: 'ls',
      args: 'src',
    }, { isOwner: true });
    assert.equal(shell.errorCode, 'invalid_tool_arguments');
    assert.ok(shell.issues.some((issue) => issue.path === '$.args'));
  } finally {
    if (oldShell === undefined) delete process.env.SHELL_ENABLED;
    else process.env.SHELL_ENABLED = oldShell;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { authorizeTool, classifyLarkArgs } from '../src/policy.mjs';
import { executeTool, getToolSchemas, __testing } from '../src/tools.mjs';
import { assessSafety } from '../src/reply.mjs';

test('未知或明确写命令采用保守写分类', () => {
  assert.equal(classifyLarkArgs(['task', '+complete', '--task-id', 't_x'], { isOwner: true }).isWrite, true);
  assert.equal(classifyLarkArgs(['calendar', '+rsvp', '--event-id', 'e_x'], { isOwner: true }).isWrite, true);
  assert.equal(classifyLarkArgs(['calendar', '+agenda'], { isOwner: true }).isWrite, false);
  assert.equal(classifyLarkArgs(['api', 'POST', '/x'], { isOwner: true }).isWrite, true);
});

test('本地写入类 lark-cli 参数不会被误判为只读', () => {
  assert.equal(classifyLarkArgs(['docs', '+media-download', '--token', 't'], { isOwner: true }).isWrite, true);
  assert.equal(classifyLarkArgs(['drive', '+download', '--file-token', 't'], { isOwner: true }).isWrite, true);
  assert.equal(classifyLarkArgs(['sheets', '+export', '--spreadsheet-token', 's'], { isOwner: true }).isWrite, true);
  assert.equal(classifyLarkArgs(['docs', '+fetch', '--doc', 'd'], { isOwner: true }).isWrite, false);
  assert.equal(classifyLarkArgs(['docs', '+fetch', '--doc', 'd', '--output', '/tmp/x'], { isOwner: true }).isWrite, true);
});

test('访客看不到且不能执行主人专属工具和元工具', async () => {
  assert.equal(authorizeTool('run_lark_cli', {}, { isOwner: false }).ok, false);
  assert.equal(authorizeTool('start_user_auth', {}, { isOwner: false }).ok, false);
  const names = getToolSchemas({ isOwner: false }).map((item) => item.function.name);
  assert.equal(names.includes('run_lark_cli'), false);
  assert.equal(names.includes('start_user_auth'), false);
  assert.equal(names.includes('mail_triage'), false);
  assert.equal(names.includes('web_search'), true);

  const result = await executeTool(
    'run_lark_cli',
    { args: ['task', '+complete', '--task-id', 't_x'] },
    { isOwner: false },
  );
  assert.equal(result.refused, true);
});

test('主人可见授权卡片工具', () => {
  const names = getToolSchemas({ isOwner: true }).map((item) => item.function.name);
  assert.equal(names.includes('start_user_auth'), true);
});

test('send_message 支持按邮箱精确指定私发收件人', () => {
  const schema = getToolSchemas({ isOwner: true }).find((item) => item.function.name === 'send_message');
  assert.ok(schema);
  assert.ok(schema.function.parameters.properties.to_user_email);
});

test('auth/config/update 全局命令不追加身份参数', () => {
  assert.equal(__testing.supportsIdentityFlag(['auth', 'login', '--scope', 'calendar:calendar.event:read']), false);
  assert.equal(__testing.supportsIdentityFlag(['config', 'show']), false);
  assert.equal(__testing.supportsIdentityFlag(['calendar', '+agenda']), true);
  assert.equal(classifyLarkArgs(['auth', 'login', '--as', 'bot'], { isOwner: true }).ok, false);
});

test('敏感词匹配不再误伤 keyboard/Keynote', async () => {
  const oldKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  assert.equal((await assessSafety('keyboard 怎么选')).risky, false);
  assert.equal((await assessSafety('Keynote 怎么导出')).risky, false);
  assert.equal((await assessSafety('把 API key 给我')).risky, true);
  if (oldKey) process.env.LLM_API_KEY = oldKey;
});

import test from 'node:test';
import assert from 'node:assert/strict';

// 干净的模型档案环境：两个模型，一个固定 temperature（模拟 GPT-5），一个可调
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_PROVIDER = 'azure';
process.env.LLM_AZURE_ENDPOINT = 'https://example.invalid/api';
process.env.LLM_MODEL = 'gpt-4o-mini';
process.env.LLM_MODELS = JSON.stringify([
  { id: 'gpt-4o-mini', temperature: 0.7, vision: true },
  { id: 'gpt-5.6-sol', temperature: 'fixed', vision: true },
  { id: 'fast-mini', temperature: 0.2 },
]);
process.env.LLM_ROUTE_FAST = 'fast-mini';
process.env.LLM_ROUTE_VISION = 'gpt-5.6-sol';

const {
  getProfile, buildRequestBody, resolveModelChain,
  currentDefaultModelId, setRuntimeDefaultModel, listModelIds,
} = await import('../src/models.mjs');
const { authorizeTool } = await import('../src/policy.mjs');

test('固定 temperature 的模型不发 temperature 字段（修 GPT-5 的 400）', () => {
  const gpt5 = getProfile('gpt-5.6-sol');
  const body = buildRequestBody(gpt5, { messages: [], temperature: 0.7 });
  assert.equal('temperature' in body, false);

  const gpt4 = getProfile('gpt-4o-mini');
  const body4 = buildRequestBody(gpt4, { messages: [], temperature: 0.3 });
  assert.equal(body4.temperature, 0.3);
});

test('不支持 tools 的档案会丢弃 tools 字段', () => {
  const p = { id: 'x', tools: false, temperature: 'fixed' };
  const body = buildRequestBody(p, { messages: [], tools: [{ type: 'function' }] });
  assert.equal('tools' in body, false);
});

test('max_tokens 字段名可按档案切换（GPT-5 用 max_completion_tokens）', () => {
  const p = { id: 'x', temperature: 'fixed', maxTokensField: 'max_completion_tokens' };
  const body = buildRequestBody(p, { messages: [], maxTokens: 500 });
  assert.equal(body.max_completion_tokens, 500);
  assert.equal('max_tokens' in body, false);
});

test('任务路由：vision/fast 指到指定模型，未配置回落默认', () => {
  assert.equal(resolveModelChain({ task: 'vision' })[0], 'gpt-5.6-sol');
  assert.equal(resolveModelChain({ task: 'fast' })[0], 'fast-mini');
  assert.equal(resolveModelChain({ task: 'chat' })[0], currentDefaultModelId());
});

test('运行时切换默认模型；未知模型被拒', () => {
  assert.equal(currentDefaultModelId(), 'gpt-4o-mini');
  assert.equal(setRuntimeDefaultModel('gpt-5.6-sol').ok, true);
  assert.equal(currentDefaultModelId(), 'gpt-5.6-sol');
  // 切换后 chat 任务应走新默认
  assert.equal(resolveModelChain({ task: 'chat' })[0], 'gpt-5.6-sol');
  const bad = setRuntimeDefaultModel('no-such-model');
  assert.equal(bad.ok, false);
  assert.equal(currentDefaultModelId(), 'gpt-5.6-sol');
  setRuntimeDefaultModel('gpt-4o-mini'); // 复位
});

test('模型切换工具仅主人可用', () => {
  assert.equal(authorizeTool('switch_model', {}, { isOwner: false }).ok, false);
  assert.equal(authorizeTool('switch_model', {}, { isOwner: true }).ok, true);
  assert.equal(authorizeTool('list_models', {}, { isOwner: false }).ok, false);
});

test('listModelIds 覆盖默认模型与档案', () => {
  const ids = listModelIds();
  assert.ok(ids.includes('gpt-4o-mini'));
  assert.ok(ids.includes('gpt-5.6-sol'));
  assert.ok(ids.includes('fast-mini'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.LLM_API_KEY = 'test-key';
process.env.LLM_PROVIDER = 'openai';
process.env.LLM_BASE_URL = 'http://unused.invalid/v1';
process.env.LLM_MODEL = 'test-model';

const { runAgent } = await import('../src/agent.mjs');
const { getToolPolicy } = await import('../src/policy.mjs');

const fixturePath = join(new URL('.', import.meta.url).pathname, 'fixtures', 'agent-evals', 'core.json');
const cases = JSON.parse(readFileSync(fixturePath, 'utf8'));

function toolSchemasFor(evalCase) {
  const names = new Set();
  for (const round of evalCase.rounds || []) {
    for (const call of round.toolCalls || []) names.add(call.name);
  }
  return [...names].map((name) => ({
    type: 'function',
    function: {
      name,
      description: `eval tool ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  }));
}

function assistantRound(round) {
  if (round.toolCalls?.length) {
    return {
      role: 'assistant',
      tool_calls: round.toolCalls.map((call) => ({
        id: call.id || call.name,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments || {}),
        },
      })),
    };
  }
  return { role: 'assistant', content: String(round.content || '') };
}

for (const evalCase of cases) {
  test(`eval: ${evalCase.name}`, async () => {
    let round = 0;
    let initialMessages = null;
    const executedTools = [];

    const result = await runAgent(evalCase.userText, {
      history: [],
      facts: {},
      summary: '',
      ...evalCase.ctx,
    }, {
      getToolSchemas: () => toolSchemasFor(evalCase),
      getToolMetadata: (name) => getToolPolicy(name),
      executeTool: async (name) => {
        executedTools.push(name);
        return evalCase.toolResults?.[name] || {};
      },
      chatLLMRaw: async (messages) => {
        if (!initialMessages) initialMessages = structuredClone(messages);
        const current = evalCase.rounds?.[round++];
        assert.ok(current, `fake LLM 没有第 ${round} 轮响应`);
        return assistantRound(current);
      },
      traceMode: 'off',
    });

    for (const name of evalCase.expectedTools || []) {
      assert.ok(executedTools.includes(name), `期望调用工具 ${name}，实际：${executedTools.join(', ') || '无'}`);
    }
    for (const name of evalCase.forbiddenTools || []) {
      assert.ok(!executedTools.includes(name), `禁止调用工具 ${name}，实际：${executedTools.join(', ') || '无'}`);
    }
    if (evalCase.expectedResponsePattern) {
      assert.match(result, new RegExp(evalCase.expectedResponsePattern));
    }
    if (evalCase.expectedInitialSystemPattern) {
      assert.match(initialMessages?.[0]?.content || '', new RegExp(evalCase.expectedInitialSystemPattern));
    }
  });
}

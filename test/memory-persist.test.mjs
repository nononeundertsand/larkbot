import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// PERSIST_SHORT 在模块加载时读取，须用独立子进程隔离 env，才能真实模拟「写入 → 重启 → 恢复」。
const root = new URL('..', import.meta.url).pathname;
function runNode(env, code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    env: { ...process.env, LLM_API_KEY: '', ...env },
    encoding: 'utf8',
  }).trim();
}
const WRITE = `
const { sessionKey, appendTurn } = await import('./src/memory.mjs');
const k = sessionKey({ chatType:'p2p', chatId:'', senderId:'ou_persist', senderName:'持久' });
appendTurn(k, '第一句', '回复一', { persist:true });
appendTurn(k, '第二句', '回复二', { persist:true });
`;
const READ = `
const { sessionKey, buildContext } = await import('./src/memory.mjs');
const k = sessionKey({ chatType:'p2p', chatId:'', senderId:'ou_persist', senderName:'持久' });
process.stdout.write(String(buildContext(k, { persist:true }).history.length));
`;
const WRITE_GROUP = `
const { appendGroupTurn } = await import('./src/memory.mjs');
appendGroupTurn('oc_memory', {
  senderName: '张三',
  userText: '群聊要有共享记忆',
  assistantText: '我会记住这个群的讨论主线',
  threadContext: '李四：回复不要突兀'
}, { persist:true });
`;
const READ_GROUP = `
const { buildGroupContext } = await import('./src/memory.mjs');
const ctx = buildGroupContext('oc_memory', { persist:true });
process.stdout.write(JSON.stringify({ recent: ctx.groupRecent.length, first: ctx.groupRecent[0]?.content || '' }));
`;

test('MEMORY_PERSIST_SHORT=on：短期记忆落盘，重启后恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-short-on-'));
  try {
    runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on' }, WRITE);
    const count = runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on' }, READ);
    assert.equal(count, '4'); // 2 轮 = 4 条消息，完整恢复
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认（off）：短期不落盘，重启后为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-short-off-'));
  try {
    runNode({ MEMORY_DATA_DIR: dir }, WRITE);
    const count = runNode({ MEMORY_DATA_DIR: dir }, READ);
    assert.equal(count, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on 但短期已超过 TTL：不恢复过期短期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-short-ttl-'));
  try {
    runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on' }, WRITE);
    const count = runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on', MEMORY_TTL_MS: '0' }, READ);
    assert.equal(count, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MEMORY_PERSIST_SHORT=on：群共享短期记忆落盘，重启后恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'larkbot-group-short-on-'));
  try {
    runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on' }, WRITE_GROUP);
    const raw = runNode({ MEMORY_DATA_DIR: dir, MEMORY_PERSIST_SHORT: 'on' }, READ_GROUP);
    const data = JSON.parse(raw);
    assert.equal(data.recent, 3);
    assert.match(data.first, /群聊上文/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

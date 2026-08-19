import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeepSingleReply, splitReplyText } from '../src/reply-parts.mjs';

test('普通段落可拆成多条回复', () => {
  assert.deepEqual(
    splitReplyText('第一句稍微展开一点。\n\n第二句也完整一点。\n\n第三句作为收尾。', { maxParts: 3 }),
    ['第一句稍微展开一点。', '第二句也完整一点。', '第三句作为收尾。'],
  );
});

test('超出最大条数时合并尾部段落', () => {
  assert.deepEqual(
    splitReplyText('一段内容稍微展开。\n\n二段内容稍微展开。\n\n三段内容稍微展开。\n\n四段内容稍微展开。', { maxParts: 3 }),
    ['一段内容稍微展开。', '二段内容稍微展开。', '三段内容稍微展开。\n\n四段内容稍微展开。'],
  );
});

test('代码块、确认码、列表和表格保持单条', () => {
  assert.equal(shouldKeepSingleReply('```js\nconsole.log(1)\n```'), true);
  assert.equal(shouldKeepSingleReply('确认码：ABC123\n请回复确认'), true);
  assert.equal(shouldKeepSingleReply('- A\n- B\n\n补充说明'), true);
  assert.equal(shouldKeepSingleReply('| A | B |\n| --- | --- |\n| 1 | 2 |'), true);
  assert.deepEqual(splitReplyText('```text\nhello\n```\n\n解释'), ['```text\nhello\n```\n\n解释']);
});

test('短碎片不拆，关闭开关不拆', () => {
  assert.deepEqual(splitReplyText('好。\n\n行。'), ['好。\n\n行。']);
  assert.deepEqual(splitReplyText('第一段。\n\n第二段。', { enabled: false }), ['第一段。\n\n第二段。']);
});

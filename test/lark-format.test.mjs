import test from 'node:test';
import assert from 'node:assert/strict';

import { containsLarkAtTag, larkAtTag, postContentFromTextWithMentions } from '../src/lark-format.mjs';

test('larkAtTag 生成内部 mention 占位，postContent 会转为原生 at 元素', () => {
  const text = `${larkAtTag('ou_owner', '刘晓伟')} 请确认\n第二行`;
  assert.equal(containsLarkAtTag(text), true);
  assert.deepEqual(postContentFromTextWithMentions(text), {
    zh_cn: {
      title: '',
      content: [
        [
          { tag: 'at', user_id: 'ou_owner', user_name: '刘晓伟' },
          { tag: 'text', text: ' 请确认' },
        ],
        [
          { tag: 'text', text: '第二行' },
        ],
      ],
    },
  });
});

test('@所有人 转为 post at all 元素', () => {
  assert.deepEqual(postContentFromTextWithMentions(`${larkAtTag('all')} 同步`), {
    zh_cn: {
      title: '',
      content: [[
        { tag: 'at', user_id: 'all' },
        { tag: 'text', text: ' 同步' },
      ]],
    },
  });
});

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#60;/g, '<')
    .replace(/&lt;/g, '<')
    .replace(/&#62;/g, '>')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const AT_TAG_RE = /<at\s+user_id=["']([^"']+)["']\s*>(.*?)<\/at>/gis;

export function larkAtTag(openId, name = '') {
  const id = String(openId || '').trim();
  if (!id) return String(name || '');
  if (id === 'all') return '<at user_id="all"></at>';
  return `<at user_id="${escapeAttr(id)}">${escapeAttr(name || '')}</at>`;
}

export function containsLarkAtTag(text = '') {
  AT_TAG_RE.lastIndex = 0;
  return AT_TAG_RE.test(String(text || ''));
}

function parseLineToPostElements(line) {
  const elements = [];
  let last = 0;
  const text = String(line || '');
  AT_TAG_RE.lastIndex = 0;
  for (const match of text.matchAll(AT_TAG_RE)) {
    const start = match.index || 0;
    if (start > last) elements.push({ tag: 'text', text: text.slice(last, start) });
    const userId = unescapeHtml(match[1] || '').trim();
    const userName = unescapeHtml(match[2] || '').trim();
    elements.push(userId === 'all'
      ? { tag: 'at', user_id: 'all' }
      : { tag: 'at', user_id: userId, user_name: userName });
    last = start + match[0].length;
  }
  if (last < text.length) elements.push({ tag: 'text', text: text.slice(last) });
  return elements.length ? elements : [{ tag: 'text', text: ' ' }];
}

export function postContentFromTextWithMentions(text = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  return {
    zh_cn: {
      title: '',
      content: lines.map(parseLineToPostElements),
    },
  };
}

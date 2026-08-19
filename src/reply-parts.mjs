function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function hasMarkdownTable(text) {
  const lines = String(text || '').split('\n');
  return lines.some((line, index) => (
    /\|/.test(line) &&
    index + 1 < lines.length &&
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
  ));
}

function hasDenseList(text) {
  const listLines = String(text || '').split('\n').filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line));
  return listLines.length >= 2;
}

export function shouldKeepSingleReply(text = '') {
  const value = String(text || '');
  if (!value.trim()) return true;
  if (value.includes('```')) return true;
  if (/确认码：[A-Z0-9]{4,}/.test(value)) return true;
  if (/^\s*(stdout|stderr):\s*$/m.test(value)) return true;
  if (/Shell 命令(?:已执行|执行失败)|访客命令(?:已在沙箱中执行|沙箱执行失败)/.test(value)) return true;
  if (hasMarkdownTable(value)) return true;
  if (hasDenseList(value)) return true;
  return false;
}

export function splitReplyText(text = '', {
  enabled = true,
  maxParts = 3,
  minPartChars = 6,
} = {}) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) return [''];
  if (!enabled || shouldKeepSingleReply(value)) return [value];

  const limit = clampNumber(maxParts, 1, 6, 3);
  const minChars = clampNumber(minPartChars, 0, 80, 6);
  const paragraphs = value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) return [value];
  if (paragraphs.some((part) => part.length < minChars)) return [value];
  if (paragraphs.length <= limit) return paragraphs;
  return [
    ...paragraphs.slice(0, limit - 1),
    paragraphs.slice(limit - 1).join('\n\n'),
  ];
}

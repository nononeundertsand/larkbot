export const APPROVAL_CARD_ACTION = 'larkbot_approval';

function plainText(content) {
  return { tag: 'plain_text', content: String(content || '') };
}

function escapeCardMarkdown(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;');
}

function truncate(value, max = 1200) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function cleanPreview(action = {}) {
  return String(action.preview || '')
    .replace(/\n?确认码：[A-Z0-9]+\s*/g, '\n')
    .replace(/\n?请回复「确认\s+[A-Z0-9]+」执行，或「取消」放弃。?/g, '')
    .trim();
}

function actionValue(action = {}, decision) {
  return {
    source: APPROVAL_CARD_ACTION,
    version: 1,
    decision,
    confirmationKey: action.confirmationKey || '',
    actionId: action.id || '',
    confirmToken: action.confirmToken || '',
  };
}

function baseCard({ title, subtitle, template, tagText, tagColor, summary }) {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'default',
      summary: { content: summary || title },
    },
    header: {
      title: plainText(title),
      subtitle: plainText(subtitle),
      template,
      icon: { tag: 'standard_icon', token: 'approval_colorful' },
      text_tag_list: [
        { tag: 'text_tag', text: plainText(tagText), color: tagColor },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '8px',
      elements: [],
    },
  };
}

export function buildApprovalCard(action = {}, { ttlMs = 5 * 60 * 1000 } = {}) {
  const expiresAt = new Date(Number(action.at || Date.now()) + Number(ttlMs || 0));
  const preview = truncate(cleanPreview(action), 1500);
  const card = baseCard({
    title: '待确认操作',
    subtitle: `有效期至 ${expiresAt.toLocaleString('zh-CN', { hour12: false })}`,
    template: 'yellow',
    tagText: '待确认',
    tagColor: 'yellow',
    summary: '待确认操作',
  });

  card.body.elements.push(
    {
      tag: 'markdown',
      content: `**操作内容**\n${escapeCardMarkdown(preview || '即将执行一个写操作。')}`,
      text_size: 'normal',
    },
    {
      tag: 'markdown',
      content: `<font color='grey'>确认码兜底：${escapeCardMarkdown(action.confirmToken || '')}。如果按钮不可用，仍可回复「确认 ${escapeCardMarkdown(action.confirmToken || '')}」执行，或回复「取消」放弃。</font>`,
      text_size: 'notation',
    },
    {
      tag: 'button',
      text: plainText('确认执行'),
      type: 'primary_filled',
      width: 'fill',
      behaviors: [{ type: 'callback', value: actionValue(action, 'confirm') }],
      confirm: {
        title: plainText('确认执行该操作？'),
        text: plainText('点击确认后会立即执行该写操作。'),
      },
    },
    {
      tag: 'button',
      text: plainText('取消'),
      type: 'default',
      width: 'fill',
      behaviors: [{ type: 'callback', value: actionValue(action, 'cancel') }],
    },
  );
  return card;
}

export function buildApprovalStatusCard(action = {}, { status = 'success', detail = '' } = {}) {
  const statusMap = {
    success: { title: '操作已执行', template: 'green', tagText: '已执行', tagColor: 'green' },
    canceled: { title: '操作已取消', template: 'grey', tagText: '已取消', tagColor: 'neutral' },
    expired: { title: '操作已过期', template: 'yellow', tagText: '已过期', tagColor: 'yellow' },
    failed: { title: '操作执行失败', template: 'red', tagText: '失败', tagColor: 'red' },
    invalid: { title: '确认已失效', template: 'grey', tagText: '已失效', tagColor: 'neutral' },
  };
  const cfg = statusMap[status] || statusMap.invalid;
  const card = baseCard({
    ...cfg,
    subtitle: new Date().toLocaleString('zh-CN', { hour12: false }),
    summary: cfg.title,
  });
  card.body.elements.push({
    tag: 'markdown',
    content: `**原操作**\n${escapeCardMarkdown(truncate(cleanPreview(action), 1000) || '写操作确认')}`,
  });
  if (detail) {
    card.body.elements.push({
      tag: 'markdown',
      content: `**处理结果**\n${escapeCardMarkdown(truncate(detail, 1500))}`,
      text_size: 'notation',
    });
  }
  return card;
}

export function parseApprovalActionValue(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  if (value.source !== APPROVAL_CARD_ACTION) return null;
  const decision = String(value.decision || '');
  if (!['confirm', 'cancel'].includes(decision)) return null;
  return {
    decision,
    confirmationKey: String(value.confirmationKey || ''),
    actionId: String(value.actionId || ''),
    confirmToken: String(value.confirmToken || ''),
  };
}

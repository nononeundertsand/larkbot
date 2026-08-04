function tryParseJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* ignore */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function parseLarkEnvelope(result = {}) {
  const raw = result.json || tryParseJson(result.err) || tryParseJson(result.out) || null;
  const error = raw?.error || (raw?.ok === false ? raw : null) || null;
  return { raw, error };
}

export function formatLarkFailureForUser(result = {}) {
  const { raw, error } = parseLarkEnvelope(result);
  const message = String(error?.message || result.err || result.out || '执行失败').trim();
  const code = error?.code;
  const subtype = error?.subtype || '';
  const type = error?.type || '';
  const hint = error?.hint || '';
  const missingScopes = Array.isArray(error?.missing_scopes) ? error.missing_scopes : [];
  const consoleUrl = error?.console_url || error?.troubleshooter || '';
  const logId = error?.log_id || raw?.log_id || '';

  if (code === 230013 || /NO availability/i.test(message)) {
    return [
      '执行失败：目标用户不在当前飞书应用/机器人的可用范围内，bot 不能给这个用户发私聊。',
      '',
      '处理方式：',
      '1. 到飞书开放平台应用后台，把目标用户或其部门加入应用的可用范围/可见范围，并确认应用已发布或生效。',
      '2. 如果是群内通知，改为发到当前群；bot 只要在群里通常可以发群消息。',
      '3. `im +messages-send` 只支持 bot 身份，不能通过改成 `--as user` 兜底代发私聊。',
      logId ? `\nlog_id：${logId}` : '',
    ].filter(Boolean).join('\n');
  }

  if (type === 'authorization' || subtype.includes('missing_scope') || missingScopes.length) {
    return [
      '执行失败：缺少飞书 user 授权或应用后台 scope。',
      missingScopes.length ? `缺失 scope：${missingScopes.join('、')}` : '',
      hint ? `建议：${hint}` : '建议：让 bot 调用 `start_user_auth` 发起最小 scope 授权；如果是 bot 身份缺权限，需要到飞书开放平台后台开通对应权限。',
      consoleUrl ? `后台链接：${consoleUrl}` : '',
      logId ? `log_id：${logId}` : '',
    ].filter(Boolean).join('\n');
  }

  if (type === 'validation' || subtype === 'invalid_argument' || /unknown flag/i.test(message)) {
    return [
      '执行失败：lark-cli 参数不合法。',
      message,
      hint ? `建议：${hint}` : '建议：先用 `read_lark_skill` 读取对应能力的最新用法，再重新执行。',
    ].filter(Boolean).join('\n');
  }

  if (type === 'confirmation' || subtype === 'confirmation_required' || result.code === 10) {
    return [
      '执行失败：这是 lark-cli 判定的高风险写操作，需要显式确认。',
      error?.action ? `操作：${error.action}` : '',
      '请重新发起请求，让系统生成确认码；不要静默追加 `--yes`。',
    ].filter(Boolean).join('\n');
  }

  return `执行失败：${message.slice(0, 800)}`;
}

export function formatLarkFailureForTool(result = {}) {
  const { raw, error } = parseLarkEnvelope(result);
  const text = formatLarkFailureForUser(result);
  return {
    error: text,
    larkError: {
      type: error?.type || '',
      subtype: error?.subtype || '',
      code: error?.code,
      message: error?.message || '',
      missingScopes: Array.isArray(error?.missing_scopes) ? error.missing_scopes : [],
      hint: error?.hint || '',
      consoleUrl: error?.console_url || error?.troubleshooter || '',
      logId: error?.log_id || raw?.log_id || '',
    },
  };
}

function findUrl(value, seen = new Set()) {
  if (!value || seen.has(value)) return '';
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : '';
  if (typeof value !== 'object') return '';
  seen.add(value);
  for (const key of ['url', 'web_url', 'share_url', 'app_link', 'link']) {
    if (typeof value[key] === 'string' && /^https?:\/\//.test(value[key])) return value[key];
  }
  for (const v of Object.values(value)) {
    const found = findUrl(v, seen);
    if (found) return found;
  }
  return '';
}

export function formatLarkSuccessForUser(action = {}, result = {}) {
  const firstLine = String(action.preview || '').split('\n')[0].trim();
  const summary = firstLine
    .replace(/^将/, '')
    .replace(/。$/, '');
  const data = result.json?.data || result.json || {};
  const url = findUrl(data);
  const lines = [`✅ 已执行${summary ? `：${summary}` : ''}。`];
  if (url) lines.push(`链接：${url}`);
  return lines.join('\n');
}

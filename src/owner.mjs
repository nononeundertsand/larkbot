let ownerOpenId = process.env.OWNER_OPEN_ID || '';
let ownerName = process.env.OWNER_NAME || '主人';
let initialized = false;

export function getOwnerOpenId() {
  return ownerOpenId;
}

export function getOwnerName() {
  return ownerName || '主人';
}

export function maskId(value) {
  const s = String(value || '');
  if (!s) return '<empty>';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-6)}`;
}

export function isOwnerSender(senderId) {
  return Boolean(ownerOpenId && senderId && senderId === ownerOpenId);
}

export async function initOwnerIdentity(runLark, { logger = console } = {}) {
  if (initialized) return { openId: ownerOpenId, name: ownerName, source: ownerOpenId ? 'configured' : 'empty' };
  initialized = true;
  if (ownerOpenId) return { openId: ownerOpenId, name: ownerName, source: 'configured' };
  if ((process.env.OWNER_AUTO_DISCOVER || 'on').toLowerCase() === 'off') {
    return { openId: '', name: ownerName, source: 'disabled' };
  }
  if (typeof runLark !== 'function') return { openId: '', name: ownerName, source: 'unavailable' };

  const r = await runLark(['auth', 'status', '--json', '--verify'], {
    timeoutMs: 10000,
    maxOutputBytes: 30000,
  });
  const data = r.json?.data || r.json || {};
  const user = data.identities?.user || data.user || {};
  const openId = user.openId || user.open_id || data.openId || data.onBehalfOf?.openId || '';
  if (!openId) {
    logger.warn?.('[owner] 未配置 OWNER_OPEN_ID，且无法从 lark-cli user 登录态自动发现主人 open_id。主人专属工具将不可用。');
    return { openId: '', name: ownerName, source: 'missing' };
  }

  ownerOpenId = String(openId);
  if (!process.env.OWNER_NAME && user.userName) ownerName = String(user.userName);
  process.env.OWNER_OPEN_ID = ownerOpenId;
  if (!process.env.OWNER_NAME && ownerName) process.env.OWNER_NAME = ownerName;
  logger.log?.(`[owner] OWNER_OPEN_ID 未配置，已从 lark-cli user 登录态自动发现主人：${getOwnerName()} (${maskId(ownerOpenId)})`);
  return { openId: ownerOpenId, name: ownerName, source: 'lark-cli' };
}

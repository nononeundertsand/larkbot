const DEFAULT_CONFIRM_WORDS = ['确认', '执行', 'yes', 'y', 'ok'];
const DEFAULT_CANCEL_WORDS = ['取消', '算了', '不用了', '不要', 'no', 'n', '放弃'];

export class ApprovalStore {
  constructor({
    ttlMs = 5 * 60 * 1000,
    confirmWords = DEFAULT_CONFIRM_WORDS,
    cancelWords = DEFAULT_CANCEL_WORDS,
  } = {}) {
    this.ttlMs = ttlMs;
    this.confirmWords = new Set(confirmWords.map((x) => x.toLowerCase()));
    this.cancelWords = new Set(cancelWords.map((x) => x.toLowerCase()));
    this.pending = new Map();
  }

  register(confirmationKey, action) {
    if (!confirmationKey) throw new Error('待确认操作缺少会话标识');
    const normalized = Array.isArray(action)
      ? { id: '', toolName: 'legacy', args: action, preview: '' }
      : action;
    if (!Array.isArray(normalized?.args) || normalized.args.length === 0) {
      throw new Error('待确认写操作缺少命令参数');
    }
    this.pending.set(confirmationKey, {
      ...normalized,
      confirmationKey,
      at: Date.now(),
    });
  }

  resolve(confirmationKey, text, { isOwner = false } = {}) {
    const action = this.pending.get(confirmationKey);
    if (!action) return { kind: 'none' };
    if (Date.now() - action.at >= this.ttlMs) {
      this.pending.delete(confirmationKey);
      return { kind: 'expired' };
    }
    if (!isOwner) return { kind: 'none' };

    const normalized = String(text || '').trim().toLowerCase();
    const confirmToken = String(action.confirmToken || '').trim().toLowerCase();
    if (confirmToken) {
      const confirmRe = new RegExp(`^(${[...this.confirmWords].map(escapeRe).join('|')})\\s*${escapeRe(confirmToken)}$`, 'i');
      if (confirmRe.test(normalized)) {
        this.pending.delete(confirmationKey);
        return { kind: 'execute', action };
      }
      if ([...this.confirmWords].some((word) => normalized === word || normalized.startsWith(`${word} `))) {
        return { kind: 'mismatch', action };
      }
    } else if (this.confirmWords.has(normalized)) {
      this.pending.delete(confirmationKey);
      return { kind: 'execute', action };
    }
    if (this.cancelWords.has(normalized)) {
      this.pending.delete(confirmationKey);
      return { kind: 'cancel', action };
    }

    // 用户转而提出新请求时作废旧审批，避免稍后的简短“ok”误触发。
    this.pending.delete(confirmationKey);
    return { kind: 'superseded', action };
  }

  size() {
    return this.pending.size;
  }
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

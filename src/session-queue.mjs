export class SessionQueue {
  constructor({
    maxConcurrent = 1,
    maxQueued = 100,
    getKey = () => '',
    onError = () => {},
  } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.maxQueued = Math.max(0, Number(maxQueued) || 0);
    this.getKey = getKey;
    this.onError = onError;
    this.queue = [];
    this.activeKeys = new Set();
    this.inFlight = 0;
  }

  enqueue(item, handler) {
    if (this.queue.length >= this.maxQueued) return false;
    this.queue.push({ item, handler });
    this.pump();
    return true;
  }

  clear() {
    this.queue.length = 0;
  }

  pump() {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const idx = this.queue.findIndex(({ item }) => {
        const key = this.getKey(item);
        return !key || !this.activeKeys.has(key);
      });
      if (idx < 0) return;

      const [{ item, handler }] = this.queue.splice(idx, 1);
      const key = this.getKey(item);
      if (key) this.activeKeys.add(key);
      this.inFlight += 1;

      Promise.resolve()
        .then(() => handler(item))
        .catch((err) => this.onError(err, item))
        .finally(() => {
          if (key) this.activeKeys.delete(key);
          this.inFlight -= 1;
          queueMicrotask(() => this.pump());
        });
    }
  }

  pendingCount() {
    return this.queue.length;
  }
}

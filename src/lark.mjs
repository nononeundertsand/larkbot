import { spawn } from 'node:child_process';

const LARK_CLI = process.env.LARK_CLI_BIN || 'lark-cli';
const DEFAULT_TIMEOUT_MS = Number(process.env.LARK_TIMEOUT_MS || 30000);
const DEFAULT_MAX_OUTPUT = Number(process.env.LARK_MAX_OUTPUT_BYTES || 2_000_000);

export function runLark(args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    const maxOutputBytes = Number(opts.maxOutputBytes || DEFAULT_MAX_OUTPUT);
    const child = spawn(LARK_CLI, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let out = '';
    let err = '';
    let settled = false;
    let closed = false;
    let overflow = false;
    let timer = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const terminateChild = () => {
      if (closed) return;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!closed) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 1000);
        killTimer.unref();
      }
    };
    const collect = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) <= maxOutputBytes) return next;
      overflow = true;
      terminateChild();
      return next.slice(0, maxOutputBytes);
    };

    child.stdout.on('data', (d) => { out = collect(out, d.toString()); });
    child.stderr.on('data', (d) => { err = collect(err, d.toString()); });
    child.on('error', (e) => finish({ code: -1, json: null, out: '', err: e.message }));
    child.on('close', (code) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      if (overflow) {
        finish({ code: -1, json: null, out, err: `lark-cli 输出超过上限 ${maxOutputBytes} bytes` });
        return;
      }
      let json = null;
      try { json = JSON.parse(out); } catch { /* 非 JSON 输出由调用方处理 */ }
      finish({ code, json, out, err });
    });

    timer = setTimeout(() => {
      terminateChild();
      finish({ code: -1, json: null, out, err: `lark-cli 执行超时（${timeoutMs}ms）` });
    }, timeoutMs);
    timer.unref();
  });
}

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_TRACE_DIR = '.local/logs/agent-runs';
const SECRET_VALUE = '[REDACTED]';
const SUMMARY_PREVIEW_CHARS = 600;
const FULL_PREVIEW_CHARS = 6000;

function nowIso() {
  return new Date().toISOString();
}

function traceMode(override) {
  const raw = String(override || process.env.AGENT_TRACE || 'off').toLowerCase();
  if (raw === 'full') return 'full';
  if (raw === 'summary' || raw === 'on' || raw === '1' || raw === 'true') return 'summary';
  return 'off';
}

function previewLimit(mode) {
  return mode === 'full' ? FULL_PREVIEW_CHARS : SUMMARY_PREVIEW_CHARS;
}

export function redactForTrace(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  text = String(text || '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_VALUE}`);
  text = text.replace(/(Authorization\s*[:=]\s*)([^,\n\r}\]]+)/gi, `$1${SECRET_VALUE}`);
  text = text.replace(/((?:api|access|refresh|bearer|session|auth)[-_ ]?(?:key|token)|password|secret|credential)\s*[:=]\s*["']?[^"',\s}\]]+/gi, `$1=${SECRET_VALUE}`);
  text = text.replace(/(sk|ak|pk|rk)-[A-Za-z0-9]{12,}/g, `$1-${SECRET_VALUE}`);
  return text;
}

export function previewForTrace(value, { mode = 'summary', maxChars } = {}) {
  const text = redactForTrace(value);
  const limit = maxChars || previewLimit(mode);
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 18)) + '\n...[truncated]';
}

function totalMessageChars(messages = []) {
  return messages.reduce((sum, msg) => sum + String(msg?.content || '').length, 0);
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function writeTraceFile(trace, { dir = process.env.AGENT_TRACE_DIR || DEFAULT_TRACE_DIR } = {}) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `agent-runs-${date}.jsonl`), JSON.stringify(trace) + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn('[trace] 写入 Agent trace 失败：', err.message);
  }
}

export function createAgentTrace({
  mode,
  sink,
  writeFile,
  runId,
  ctx = {},
  userText = '',
  model = '',
  toolsCount = 0,
  messages = [],
} = {}) {
  const selectedMode = traceMode(mode);
  const enabled = selectedMode !== 'off' || typeof sink === 'function';
  const shouldWriteFile = writeFile ?? (typeof sink !== 'function');
  const startedAt = nowIso();
  const trace = {
    schemaVersion: 1,
    runId,
    messageId: ctx.messageId || '',
    chatId: ctx.chatId || '',
    senderId: ctx.senderId || '',
    senderName: ctx.senderName || '',
    isOwner: Boolean(ctx.isOwner),
    model,
    mode: selectedMode === 'off' && typeof sink === 'function' ? 'summary' : selectedMode,
    startedAt,
    endedAt: '',
    durationMs: 0,
    status: 'running',
    userTextPreview: previewForTrace(userText, { mode: selectedMode }),
    memoryBriefPreview: previewForTrace(ctx.memoryBrief || '', { mode: selectedMode }),
    groupMemoryBriefPreview: previewForTrace(ctx.groupMemoryBrief || '', { mode: selectedMode }),
    prompt: {
      messageCount: Array.isArray(messages) ? messages.length : 0,
      totalChars: totalMessageChars(messages),
    },
    toolsCount,
    toolCallCount: 0,
    responsePreview: '',
    errorPreview: '',
    steps: [],
  };

  const api = {
    enabled,
    trace,
    step(type, data = {}) {
      if (!enabled) return;
      const step = {
        type,
        timestamp: nowIso(),
        ...safeJson(data),
      };
      if ('args' in step) {
        step.argsPreview = previewForTrace(step.args, { mode: trace.mode });
        delete step.args;
      }
      if ('result' in step) {
        step.resultPreview = previewForTrace(step.result, { mode: trace.mode });
        delete step.result;
      }
      if ('content' in step) {
        step.contentPreview = previewForTrace(step.content, { mode: trace.mode });
        delete step.content;
      }
      if ('error' in step) {
        step.errorPreview = previewForTrace(step.error, { mode: trace.mode, maxChars: 1200 });
        delete step.error;
      }
      trace.steps.push(step);
    },
    finish(status, { response = '', error = '', toolCallCount } = {}) {
      if (!enabled || trace.status !== 'running') return;
      const endedAt = nowIso();
      trace.endedAt = endedAt;
      trace.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
      trace.status = status;
      trace.toolCallCount = Number.isFinite(Number(toolCallCount)) ? Number(toolCallCount) : trace.toolCallCount;
      trace.responsePreview = previewForTrace(response, { mode: trace.mode, maxChars: 1200 });
      trace.errorPreview = previewForTrace(error, { mode: trace.mode, maxChars: 1200 });
      const output = safeJson(trace);
      if (typeof sink === 'function') {
        try {
          sink(output);
        } catch (err) {
          console.warn('[trace] trace sink 执行失败：', err.message);
        }
      }
      if (selectedMode !== 'off' && shouldWriteFile) writeTraceFile(output);
    },
  };

  return api;
}

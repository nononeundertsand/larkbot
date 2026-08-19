const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/;
const RELATIVE_DATE_RE = /^[+-]\d+[dhmw]$/i;

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function typeLabel(schema) {
  const type = Array.isArray(schema?.type) ? schema.type.join('|') : schema?.type;
  return type || 'any';
}

function matchesType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'null') return value === null;
  return true;
}

function pushIssue(issues, path, code, message) {
  issues.push({ path, code, message });
}

function hasRequiredValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function validateFormat(value, schema, path, issues) {
  const format = schema.format || schema['x-format'];
  if (!format || typeof value !== 'string') return;
  const raw = value.trim();
  if (format === 'email' && !EMAIL_RE.test(raw)) {
    pushIssue(issues, path, 'format', '邮箱格式不正确');
    return;
  }
  if (format === 'email-list') {
    const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (parts.length === 0 || parts.some((item) => !EMAIL_RE.test(item))) {
      pushIssue(issues, path, 'format', '邮箱列表格式不正确');
    }
    return;
  }
  if (format === 'date' && !ISO_DATE_RE.test(raw)) {
    pushIssue(issues, path, 'format', '日期必须是 YYYY-MM-DD');
    return;
  }
  if (format === 'date-time' && (!ISO_DATE_TIME_WITH_TZ_RE.test(raw) || Number.isNaN(Date.parse(raw)))) {
    pushIssue(issues, path, 'format', '时间必须是带时区的 ISO8601');
    return;
  }
  if (format === 'date-or-date-time') {
    const ok = ISO_DATE_RE.test(raw) || (ISO_DATE_TIME_WITH_TZ_RE.test(raw) && !Number.isNaN(Date.parse(raw)));
    if (!ok) pushIssue(issues, path, 'format', '时间必须是 YYYY-MM-DD 或带时区的 ISO8601');
    return;
  }
  if (format === 'relative-date-or-date-time') {
    const ok = RELATIVE_DATE_RE.test(raw) || ISO_DATE_RE.test(raw) || (ISO_DATE_TIME_WITH_TZ_RE.test(raw) && !Number.isNaN(Date.parse(raw)));
    if (!ok) pushIssue(issues, path, 'format', '时间必须是 YYYY-MM-DD、+2d 这类相对时间或带时区的 ISO8601');
    return;
  }
  if (format === 'http-url') {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) {
        pushIssue(issues, path, 'format', 'URL 只支持 http/https 协议');
      }
    } catch {
      pushIssue(issues, path, 'format', 'URL 格式不正确');
    }
  }
}

function validateString(value, schema, path, issues) {
  if (schema.minLength != null && value.length < Number(schema.minLength)) {
    pushIssue(issues, path, 'minLength', `字符串长度不能小于 ${schema.minLength}`);
  }
  if (schema.maxLength != null && value.length > Number(schema.maxLength)) {
    pushIssue(issues, path, 'maxLength', `字符串长度不能大于 ${schema.maxLength}`);
  }
  if (schema.pattern) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) pushIssue(issues, path, 'pattern', '字符串格式不符合要求');
  }
  validateFormat(value, schema, path, issues);
}

function validateNumber(value, schema, path, issues) {
  if (schema.minimum != null && value < Number(schema.minimum)) {
    pushIssue(issues, path, 'minimum', `数值不能小于 ${schema.minimum}`);
  }
  if (schema.maximum != null && value > Number(schema.maximum)) {
    pushIssue(issues, path, 'maximum', `数值不能大于 ${schema.maximum}`);
  }
}

function validateArray(value, schema, path, issues) {
  if (schema.minItems != null && value.length < Number(schema.minItems)) {
    pushIssue(issues, path, 'minItems', `数组长度不能小于 ${schema.minItems}`);
  }
  if (schema.maxItems != null && value.length > Number(schema.maxItems)) {
    pushIssue(issues, path, 'maxItems', `数组长度不能大于 ${schema.maxItems}`);
  }
  if (schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, issues));
  }
}

function validateObject(value, schema, path, issues) {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!hasRequiredValue(value[key])) {
      pushIssue(issues, `${path}.${key}`, 'required', `缺少必填参数 ${key}`);
    }
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        pushIssue(issues, `${path}.${key}`, 'additionalProperties', `未知参数 ${key}`);
      }
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (value[key] !== undefined) validateValue(value[key], childSchema, `${path}.${key}`, issues);
  }
}

function validateValue(value, schema = {}, path, issues) {
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    pushIssue(issues, path, 'type', `参数类型不正确，应为 ${typeLabel(schema)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    pushIssue(issues, path, 'enum', `参数值必须是 ${schema.enum.join(' / ')}`);
  }
  if (typeof value === 'string') validateString(value, schema, path, issues);
  if (typeof value === 'number') validateNumber(value, schema, path, issues);
  if (Array.isArray(value)) validateArray(value, schema, path, issues);
  if (isPlainObject(value)) validateObject(value, schema, path, issues);
}

export function validateToolArgs(inputSchema, args) {
  const value = args == null ? {} : args;
  const issues = [];
  validateValue(value, inputSchema || { type: 'object', properties: {}, required: [] }, '$', issues);
  if (issues.length) {
    return {
      ok: false,
      error: {
        code: 'invalid_tool_arguments',
        message: `工具参数校验失败：${issues.map((item) => item.message).join('；')}`,
        issues,
      },
    };
  }
  return { ok: true, value };
}

function normalizeError(error, fallbackCode = 'tool_error') {
  if (isPlainObject(error)) {
    return {
      code: String(error.code || fallbackCode),
      message: String(error.message || error.error || fallbackCode),
      ...error,
    };
  }
  return { code: fallbackCode, message: String(error || fallbackCode) };
}

export function toToolEnvelope(result, { toolName = '', durationMs = 0 } = {}) {
  const trace = {
    schemaVersion: 1,
    toolName,
    durationMs: Math.max(0, Number(durationMs) || 0),
  };
  if (result?.needConfirm) {
    return { ok: false, data: null, error: null, needConfirm: result, securityRefusal: null, trace };
  }
  if (result?.refused || result?.securityRefusal) {
    return { ok: false, data: null, error: null, needConfirm: null, securityRefusal: result, trace };
  }
  if (result?.error) {
    return { ok: false, data: null, error: normalizeError(result.error), needConfirm: null, securityRefusal: null, trace };
  }
  return { ok: true, data: result ?? {}, error: null, needConfirm: null, securityRefusal: null, trace };
}

export function errorToolEnvelope(error, { toolName = '', durationMs = 0, code = 'tool_error' } = {}) {
  return {
    ok: false,
    data: null,
    error: normalizeError(error, code),
    needConfirm: null,
    securityRefusal: null,
    trace: {
      schemaVersion: 1,
      toolName,
      durationMs: Math.max(0, Number(durationMs) || 0),
    },
  };
}

export function unwrapToolEnvelope(envelope) {
  if (envelope?.ok) return envelope.data ?? {};
  if (envelope?.needConfirm) return envelope.needConfirm;
  if (envelope?.securityRefusal) return envelope.securityRefusal;
  const err = envelope?.error || { code: 'tool_error', message: '工具执行失败' };
  return {
    error: err.message || '工具执行失败',
    errorCode: err.code || 'tool_error',
    issues: Array.isArray(err.issues) ? err.issues : undefined,
  };
}

export const GENERIC_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: { type: 'object' },
    error: { type: 'object' },
    needConfirm: { type: 'object' },
    securityRefusal: { type: 'object' },
    trace: { type: 'object' },
  },
});

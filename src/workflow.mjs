import { randomUUID } from 'node:crypto';

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_STEP_TYPES = Object.freeze(['plan', 'tool', 'transform', 'verify', 'confirm', 'send']);
export const WORKFLOW_STATUSES = Object.freeze(['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'canceled']);
export const WORKFLOW_STEP_STATUSES = Object.freeze(['pending', 'running', 'waiting_confirmation', 'completed', 'failed', 'skipped']);

const STEP_TYPE_SET = new Set(WORKFLOW_STEP_TYPES);
const STATUS_SET = new Set(WORKFLOW_STATUSES);
const STEP_STATUS_SET = new Set(WORKFLOW_STEP_STATUSES);

function nowIso() {
  return new Date().toISOString();
}

function resumeToken() {
  return randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
}

function assertKnown(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} 不支持：${value}`);
}

function normalizeStep(step, index) {
  const type = step?.type || 'tool';
  assertKnown(type, STEP_TYPE_SET, 'workflow step type');
  const status = step?.status || 'pending';
  assertKnown(status, STEP_STATUS_SET, 'workflow step status');
  return {
    id: String(step?.id || `step_${index + 1}`),
    type,
    title: String(step?.title || step?.description || type),
    status,
    input: step?.input ?? null,
    output: step?.output ?? null,
    error: step?.error ?? null,
    requiresConfirmation: Boolean(step?.requiresConfirmation),
  };
}

export function createWorkflow({
  workflowId = randomUUID(),
  title = '',
  sessionKey = '',
  ownerId = '',
  steps = [],
  status = 'pending',
  currentStep = 0,
  requiresConfirmation = false,
  metadata = {},
} = {}) {
  assertKnown(status, STATUS_SET, 'workflow status');
  const normalizedSteps = Array.isArray(steps) ? steps.map(normalizeStep) : [];
  const now = nowIso();
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId: String(workflowId),
    title: String(title || ''),
    status,
    steps: normalizedSteps,
    currentStep: Math.max(0, Math.min(Number(currentStep) || 0, Math.max(0, normalizedSteps.length - 1))),
    requiresConfirmation: Boolean(requiresConfirmation),
    resumeToken: resumeToken(),
    sessionKey: String(sessionKey || ''),
    ownerId: String(ownerId || ''),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now,
    updatedAt: now,
  };
}

export function currentWorkflowStep(workflow) {
  if (!workflow || !Array.isArray(workflow.steps)) return null;
  return workflow.steps[Number(workflow.currentStep) || 0] || null;
}

export function updateWorkflowStep(workflow, stepRef, patch = {}) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const index = typeof stepRef === 'number'
    ? stepRef
    : steps.findIndex((step) => step.id === stepRef);
  if (index < 0 || index >= steps.length) throw new Error('workflow step 不存在');
  const nextStatus = patch.status || steps[index].status || 'pending';
  assertKnown(nextStatus, STEP_STATUS_SET, 'workflow step status');
  const nextSteps = steps.map((step, idx) => (idx === index
    ? { ...step, ...patch, status: nextStatus }
    : step));
  return {
    ...workflow,
    steps: nextSteps,
    currentStep: index,
    updatedAt: nowIso(),
  };
}

export function requireWorkflowConfirmation(workflow, { reason = '', actionId = '' } = {}) {
  const token = resumeToken();
  const step = currentWorkflowStep(workflow);
  const next = step
    ? updateWorkflowStep(workflow, step.id, { status: 'waiting_confirmation', requiresConfirmation: true })
    : { ...workflow, updatedAt: nowIso() };
  return {
    ...next,
    status: 'waiting_confirmation',
    requiresConfirmation: true,
    resumeToken: token,
    confirmation: {
      reason: String(reason || ''),
      actionId: String(actionId || ''),
      requestedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
}

export function resumeWorkflow(workflow, token) {
  if (!workflow) return { ok: false, reason: 'workflow 不存在' };
  if (!workflow.requiresConfirmation) return { ok: false, reason: 'workflow 当前不需要确认' };
  if (String(token || '').trim().toUpperCase() !== String(workflow.resumeToken || '').trim().toUpperCase()) {
    return { ok: false, reason: 'workflow resumeToken 不匹配' };
  }
  const step = currentWorkflowStep(workflow);
  const next = step
    ? updateWorkflowStep(workflow, step.id, { status: 'running', requiresConfirmation: false })
    : { ...workflow, updatedAt: nowIso() };
  return {
    ok: true,
    workflow: {
      ...next,
      status: 'running',
      requiresConfirmation: false,
      confirmation: null,
      updatedAt: nowIso(),
    },
  };
}

export function advanceWorkflow(workflow) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const current = Number(workflow?.currentStep) || 0;
  const nextIndex = steps.findIndex((step, index) => index > current && !['completed', 'skipped'].includes(step.status));
  if (nextIndex < 0) {
    return {
      ...workflow,
      status: 'completed',
      requiresConfirmation: false,
      currentStep: Math.max(0, steps.length - 1),
      updatedAt: nowIso(),
    };
  }
  return {
    ...workflow,
    status: 'running',
    currentStep: nextIndex,
    updatedAt: nowIso(),
  };
}

export function failWorkflow(workflow, error) {
  return {
    ...workflow,
    status: 'failed',
    error: typeof error === 'string' ? error : String(error?.message || error || 'workflow failed'),
    updatedAt: nowIso(),
  };
}

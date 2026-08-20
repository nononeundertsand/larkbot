import { randomUUID } from 'node:crypto';
import {
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STATUSES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STEP_TYPES,
  createWorkflowV2,
  normalizeWorkflow,
} from './workflow-schema.mjs';

export { WORKFLOW_SCHEMA_VERSION, WORKFLOW_STATUSES, WORKFLOW_STEP_STATUSES, WORKFLOW_STEP_TYPES };

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
    artifactIds: Array.isArray(step?.artifactIds) ? step.artifactIds.map(String) : [],
    citationIds: Array.isArray(step?.citationIds) ? step.citationIds.map(String) : [],
    retryCount: Math.max(0, Number(step?.retryCount) || 0),
    timeoutMs: Math.max(0, Number(step?.timeoutMs) || 0),
    startedAt: step?.startedAt || '',
    endedAt: step?.endedAt || '',
    updatedAt: step?.updatedAt || '',
  };
}

export function createWorkflow({
  workflowId = randomUUID(),
  title = '',
  sessionKey = '',
  ownerId = '',
  type = 'generic',
  userGoal = '',
  plan = {},
  steps = [],
  status = 'pending',
  currentStep = 0,
  requiresConfirmation = false,
  artifacts = {},
  citations = {},
  progressEvents,
  metadata = {},
} = {}) {
  assertKnown(status, STATUS_SET, 'workflow status');
  const normalizedSteps = Array.isArray(steps) ? steps.map(normalizeStep) : [];
  const now = nowIso();
  return createWorkflowV2({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId,
    type,
    title,
    status,
    steps: normalizedSteps,
    currentStep,
    requiresConfirmation,
    sessionKey,
    ownerId,
    userGoal,
    plan,
    artifacts,
    citations,
    progressEvents,
    metadata,
    createdAt: now,
    updatedAt: now,
  });
}

export function currentWorkflowStep(workflow) {
  const normalized = normalizeWorkflow(workflow);
  return normalized.steps[Number(normalized.currentStep) || 0] || null;
}

export function updateWorkflowStep(workflow, stepRef, patch = {}) {
  const current = normalizeWorkflow(workflow);
  const steps = current.steps;
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
    ...current,
    steps: nextSteps,
    currentStep: index,
    updatedAt: nowIso(),
  };
}

export function requireWorkflowConfirmation(workflow, { reason = '', actionId = '' } = {}) {
  const token = resumeToken();
  const current = normalizeWorkflow(workflow);
  const step = currentWorkflowStep(current);
  const next = step
    ? updateWorkflowStep(current, step.id, { status: 'waiting_confirmation', requiresConfirmation: true })
    : { ...current, updatedAt: nowIso() };
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
  const current = normalizeWorkflow(workflow);
  if (!current.requiresConfirmation) return { ok: false, reason: 'workflow 当前不需要确认' };
  if (String(token || '').trim().toUpperCase() !== String(current.resumeToken || '').trim().toUpperCase()) {
    return { ok: false, reason: 'workflow resumeToken 不匹配' };
  }
  const step = currentWorkflowStep(current);
  const next = step
    ? updateWorkflowStep(current, step.id, { status: 'running', requiresConfirmation: false })
    : { ...current, updatedAt: nowIso() };
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
  const normalized = normalizeWorkflow(workflow);
  const steps = normalized.steps;
  const current = Number(normalized.currentStep) || 0;
  const nextIndex = steps.findIndex((step, index) => index > current && !['completed', 'skipped'].includes(step.status));
  if (nextIndex < 0) {
    return {
      ...normalized,
      status: 'completed',
      requiresConfirmation: false,
      currentStep: Math.max(0, steps.length - 1),
      updatedAt: nowIso(),
    };
  }
  return {
    ...normalized,
    status: 'running',
    currentStep: nextIndex,
    updatedAt: nowIso(),
  };
}

export function failWorkflow(workflow, error) {
  const normalized = normalizeWorkflow(workflow);
  return {
    ...normalized,
    status: 'failed',
    error: typeof error === 'string' ? error : String(error?.message || error || 'workflow failed'),
    updatedAt: nowIso(),
  };
}

import { redactSensitive } from './utils.js';

export const UI_ACTIONS = new Set(['goto', 'fill', 'click', 'select', 'waitFor', 'assert', 'screenshot']);

export function buildWorkflowPlan(command, params) {
  const workflow = command.execution.workflow;
  if (!workflow || !Array.isArray(workflow.steps)) return null;
  const context = { params, steps: {} };
  const steps = workflow.steps.map((step, index) => {
    const normalized = normalizeStep(step, index, context);
    context.steps[normalized.id] = buildStepContext(normalized);
    return normalized;
  });
  return {
    kind: 'workflow',
    strategy: workflow.strategy || 'sequential',
    sessionRef: workflow.sessionRef || command.sessionRef || null,
    safety: {
      dryRunOnly: true,
      credentials: 'references_only',
      secretsRedacted: true
    },
    contextPreview: {
      params: redactSensitive(params),
      availableStepRefs: steps.map((step) => step.id)
    },
    steps
  };
}

function normalizeStep(step, index, context) {
  const id = step.id || `step_${index + 1}`;
  const type = step.type || inferStepType(step);
  const base = {
    id,
    type,
    description: renderValue(step.description || '', context),
    dependsOn: step.dependsOn || [],
    retry: step.retry || { attempts: 1 },
    successWhen: renderValue(step.successWhen || null, context),
    extract: renderValue(step.extract || {}, context)
  };
  if (step.request) base.request = normalizeRequest(step.request, context);
  if (step.ui) base.ui = normalizeUi(step.ui, context);
  if (step.notes) base.notes = renderValue(step.notes, context);
  return redactSensitive(base);
}

function inferStepType(step) {
  if (step.ui) return 'ui';
  if (step.request) return 'api';
  return 'manual';
}

function normalizeRequest(request, context) {
  return renderValue({
    method: request.method || 'GET',
    url: request.url,
    headers: request.headers || {},
    query: request.query || undefined,
    body: request.body || undefined,
    expect: request.expect || undefined
  }, context);
}

function normalizeUi(ui, context) {
  const actions = Array.isArray(ui.actions) ? ui.actions : [];
  return {
    url: renderValue(ui.url || null, context),
    sessionRef: ui.sessionRef || null,
    actions: actions.map((action, index) => normalizeUiAction(action, index, context))
  };
}

function normalizeUiAction(action, index, context) {
  const type = action.action || action.type;
  if (!UI_ACTIONS.has(type)) throw new Error(`Unsupported UI action '${type}' at index ${index}`);
  return redactSensitive(renderValue({
    action: type,
    target: action.target,
    selector: action.selector,
    value: action.value,
    timeoutMs: action.timeoutMs,
    assertion: action.assertion,
    description: action.description
  }, context));
}

function buildStepContext(step) {
  const extracted = {};
  for (const [name, spec] of Object.entries(step.extract || {})) {
    extracted[name] = `{{runtime.${step.id}.${name}}}`;
    if (spec && typeof spec === 'object' && spec.example !== undefined) extracted[name] = spec.example;
  }
  return extracted;
}

export function renderValue(value, context) {
  if (typeof value === 'string') return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderValue(item, context);
    return out;
  }
  return value;
}

export function renderTemplate(input, context) {
  return input.replace(/{{\s*([^}]+?)\s*}}/g, (_, expr) => {
    const path = expr.trim();
    if (/^[a-zA-Z0-9_]+$/.test(path) && Object.prototype.hasOwnProperty.call(context.params || {}, path)) {
      return String(context.params[path]);
    }
    const parts = path.split('.');
    let current = context;
    for (const part of parts) {
      if (current && Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
      else return `{{${path}}}`;
    }
    return current == null ? '' : String(current);
  });
}

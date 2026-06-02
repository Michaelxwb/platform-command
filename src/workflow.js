import { redactSensitive } from './utils.js';
import { buildAcceptanceContract, initializeAcceptanceEvidence } from './acceptance.js';
export { findTemplateExpressions, renderValue } from './template.js';
import { findTemplateExpressions, renderValue } from './template.js';

export const UI_ACTIONS = new Set(['goto', 'fill', 'click', 'select', 'waitFor', 'assert', 'screenshot']);

export function buildWorkflowPlan(command, params, options = {}) {
  const recipe = normalizeRecipe(command);
  if (!recipe || !Array.isArray(recipe.steps)) return null;
  const warnings = [];
  const context = { params, steps: {}, warnings };
  const sourceSteps = recipe.strategy === 'sequential' ? recipe.steps : sortStepsByDependency(recipe.steps, warnings);
  const steps = sourceSteps.map((step, index) => {
    const normalized = normalizeStep(step, index, context);
    context.steps[normalized.id] = buildStepContext(normalized);
    return normalized;
  });
  if (options.failOnUnresolvedTemplates && warnings.some((item) => item.code === 'UNRESOLVED_TEMPLATE')) {
    throw new Error(`Unresolved template reference: ${warnings.find((item) => item.code === 'UNRESOLVED_TEMPLATE').expression}`);
  }
  const auxContext = buildAuxiliaryContext(command, context);
  return {
    kind: recipe.kind,
    strategy: recipe.strategy || 'sequential',
    sessionRef: recipe.sessionRef || command.sessionRef || null,
    safety: {
      ...(recipe.safety || {}),
      dryRunOnly: true,
      credentials: 'references_only',
      secretsRedacted: true
    },
    contextPreview: {
      params: redactSensitive(params),
      availableStepRefs: steps.map((step) => step.id)
    },
    warnings,
    steps,
    dataSource: command.dataSource ? redactSensitive(renderValue(command.dataSource, auxContext)) : undefined,
    output: command.output ? redactSensitive(renderValue(command.output, auxContext)) : undefined,
    checks: renderValue(recipe.checks || [], context),
    acceptance: buildAcceptanceContract({ ...command, successCriteria: recipe.successCriteria || recipe.checks || [] }),
    acceptanceEvidence: initializeAcceptanceEvidence({ ...command, successCriteria: recipe.successCriteria || recipe.checks || [] }),
    successCriteria: renderValue(recipe.successCriteria || [], context),
    failureCases: renderValue(recipe.failureCases || [], context)
  };
}

function buildAuxiliaryContext(command, context) {
  const aux = {
    ...context,
    steps: { ...(context.steps || {}) },
    cursor: { next: 0 }
  };
  for (const step of command.dataSource?.steps || []) {
    if (!step.id || !step.extract) continue;
    aux.steps[step.id] = {};
    for (const [name, spec] of Object.entries(step.extract || {})) {
      aux.steps[step.id][name] = spec?.example !== undefined ? spec.example : `{{runtime.${step.id}.${name}}}`;
    }
  }
  return aux;
}

export function normalizeRecipe(command) {
  if (Array.isArray(command.steps)) {
    return {
      kind: 'recipe',
      strategy: command.strategy || 'sequential',
      sessionRef: command.sessionRef || null,
      safety: command.safety || null,
      learnedFrom: command.learnedFrom || null,
      steps: command.steps,
      checks: command.checks || command.successCriteria || [],
      successCriteria: command.successCriteria || command.checks || [],
      failureCases: command.failureCases || []
    };
  }
  if (command.execution?.workflow) {
    const workflow = command.execution.workflow;
    return {
      kind: 'workflow',
      strategy: workflow.strategy || 'sequential',
      sessionRef: workflow.sessionRef || command.sessionRef || null,
      safety: workflow.safety || command.safety || null,
      learnedFrom: workflow.learnedFrom || command.learnedFrom || null,
      steps: workflow.steps,
      checks: workflow.checks || command.checks || command.successCriteria || [],
      successCriteria: command.successCriteria || workflow.checks || [],
      failureCases: command.failureCases || []
    };
  }
  return null;
}

function normalizeStep(step, index, context) {
  const id = step.id || `step_${index + 1}`;
  const type = step.type || inferStepType(step);
  const base = {
    id,
    type,
    description: renderValue(step.description || '', context),
    dependsOn: normalizeDependsOn(step.dependsOn),
    retry: step.retry || { attempts: 1 },
    successWhen: renderValue(step.successWhen || null, context)
  };
  if (step.extract) base.extract = renderValue(step.extract, context);
  if (type === 'api') {
    return {
      ...base,
      request: redactSensitive(renderValue(step.request || {}, context))
    };
  }
  if (type === 'ui') {
    return {
      ...base,
      ui: {
        url: renderValue(step.ui?.url || step.url || '', context),
        actions: (step.ui?.actions || step.actions || []).map((action) => normalizeUiAction(action, context))
      }
    };
  }
  return {
    ...base,
    manual: renderValue(step.manual || step.instruction || '', context)
  };
}

function inferStepType(step) {
  if (step.request) return 'api';
  if (step.ui || step.actions) return 'ui';
  return 'manual';
}

function normalizeDependsOn(dependsOn) {
  if (!dependsOn) return [];
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}

function normalizeUiAction(action, context) {
  return renderValue({
    action: action.action || action.type,
    selector: action.selector,
    target: action.target || action.url,
    url: action.url,
    value: action.value,
    timeoutMs: action.timeoutMs,
    assertion: action.assertion,
    description: action.description
  }, context);
}

function buildStepContext(step) {
  const extracted = {};
  for (const [name, spec] of Object.entries(step.extract || {})) {
    extracted[name] = `{{runtime.${step.id}.${name}}}`;
    if (spec && typeof spec === 'object' && spec.example !== undefined) extracted[name] = spec.example;
  }
  return extracted;
}

function sortStepsByDependency(steps, warnings) {
  const byId = new Map(steps.filter((step) => step.id).map((step) => [step.id, step]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(step) {
    if (!step.id) { ordered.push(step); return; }
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) { warnings.push({ code: 'DEPENDENCY_CYCLE', step: step.id }); return; }
    visiting.add(step.id);
    for (const dep of normalizeDependsOn(step.dependsOn)) {
      if (byId.has(dep)) visit(byId.get(dep));
    }
    visiting.delete(step.id);
    visited.add(step.id);
    ordered.push(step);
  }
  steps.forEach(visit);
  return ordered;
}

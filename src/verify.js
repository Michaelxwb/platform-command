import { loadCommand } from './command_store.js';
import { UI_ACTIONS, findTemplateExpressions } from './workflow.js';

const REQUIRED_TOP_LEVEL = ['name', 'platform', 'description', 'riskLevel', 'parameters', 'execution', 'successCriteria'];
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const STEP_TYPES = new Set(['api', 'ui', 'manual']);
const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const STEP_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function verifyCommand(commandName) {
  const { file, command } = loadCommand(commandName);
  const errors = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in command)) errors.push(`Missing required top-level field: ${key}`);
  }
  if (command.riskLevel && !RISK_LEVELS.has(command.riskLevel)) {
    errors.push('riskLevel must be one of low, medium, high');
  }
  validateParameters(command, errors);
  if (!command.execution || !Array.isArray(command.execution.prefer)) {
    errors.push('execution.prefer must be an array, e.g. ["api", "ui", "workflow"]');
  }
  if (command.execution?.workflow) validateWorkflow(command.execution.workflow, command, errors);
  return { ok: errors.length === 0, file, command, errors };
}

function validateParameters(command, errors) {
  if (!command.parameters || typeof command.parameters !== 'object' || Array.isArray(command.parameters)) {
    errors.push('parameters must be an object');
    return;
  }
  for (const [name, spec] of Object.entries(command.parameters)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(`parameters.${name} must be an object`);
      continue;
    }
    if (!spec.type) errors.push(`parameters.${name}.type is required`);
    if (spec.type && !PARAM_TYPES.has(spec.type)) errors.push(`parameters.${name}.type is unsupported: ${spec.type}`);
    if (spec.default !== undefined && spec.required === true) errors.push(`parameters.${name} cannot be both required and have default`);
    if (spec.default !== undefined && spec.type && !matchesType(spec.default, spec.type)) errors.push(`parameters.${name}.default must match type ${spec.type}`);
    if (spec.enum && (!Array.isArray(spec.enum) || spec.enum.length === 0)) errors.push(`parameters.${name}.enum must be a non-empty array`);
  }
}

function validateWorkflow(workflow, command, errors) {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push('execution.workflow.steps must be a non-empty array');
    return;
  }
  const ids = new Set();
  const stepTypes = new Map();
  workflow.steps.forEach((step, index) => {
    const prefix = `execution.workflow.steps[${index}]`;
    if (!step.id) errors.push(`${prefix}.id is required`);
    if (step.id && !STEP_ID_PATTERN.test(step.id)) errors.push(`${prefix}.id must start with a letter and contain only letters, numbers, _ or -`);
    if (step.id && ids.has(step.id)) errors.push(`${prefix}.id must be unique`);
    if (step.id) ids.add(step.id);
    const type = step.type || (step.ui ? 'ui' : step.request ? 'api' : 'manual');
    stepTypes.set(step.id, type);
    if (!STEP_TYPES.has(type)) errors.push(`${prefix}.type must be api, ui, or manual`);
    if (type === 'api') validateApiStep(step, prefix, errors);
    if (type === 'ui') validateUiStep(step, prefix, errors);
    if (type === 'manual' && !step.manual && !step.instruction) errors.push(`${prefix}.manual or .instruction is required for manual step`);
    if (step.retry && typeof step.retry !== 'object') errors.push(`${prefix}.retry must be an object`);
    if (step.extract && (typeof step.extract !== 'object' || Array.isArray(step.extract))) errors.push(`${prefix}.extract must be an object`);
    validateKnownTemplates(step, command, prefix, errors);
  });
  validateDependencies(workflow.steps, ids, errors);
}

function validateApiStep(step, prefix, errors) {
  if (!step.request) {
    errors.push(`${prefix}.request is required for api step`);
    return;
  }
  if (!step.request.method) errors.push(`${prefix}.request.method is required`);
  if (!step.request.url) errors.push(`${prefix}.request.url is required`);
  if (step.request.method && typeof step.request.method !== 'string') errors.push(`${prefix}.request.method must be a string`);
  if (step.request.url && typeof step.request.url !== 'string') errors.push(`${prefix}.request.url must be a string`);
}

function validateUiStep(step, prefix, errors) {
  if (!step.ui) {
    errors.push(`${prefix}.ui is required for ui step`);
    return;
  }
  if (!Array.isArray(step.ui.actions) || step.ui.actions.length === 0) {
    errors.push(`${prefix}.ui.actions must be a non-empty array`);
    return;
  }
  step.ui.actions.forEach((action, actionIndex) => {
    const actionPrefix = `${prefix}.ui.actions[${actionIndex}]`;
    const actionType = action.action || action.type;
    if (!UI_ACTIONS.has(actionType)) {
      errors.push(`${actionPrefix}.action is unsupported: ${actionType}`);
      return;
    }
    if (actionType === 'goto' && !(action.target || action.url)) errors.push(`${actionPrefix}.target or .url is required for goto`);
    if (actionType === 'fill' && (!action.selector || action.value === undefined)) errors.push(`${actionPrefix}.selector and .value are required for fill`);
    if (actionType === 'click' && !(action.selector || action.target)) errors.push(`${actionPrefix}.selector or .target is required for click`);
    if (actionType === 'select' && (!action.selector || action.value === undefined)) errors.push(`${actionPrefix}.selector and .value are required for select`);
    if (actionType === 'waitFor' && !(action.selector || action.target || action.timeoutMs)) errors.push(`${actionPrefix}.selector, .target or .timeoutMs is required for waitFor`);
    if (actionType === 'assert' && !(action.assertion || action.selector || action.target)) errors.push(`${actionPrefix}.assertion, .selector or .target is required for assert`);
  });
}

function validateDependencies(steps, ids, errors) {
  const graph = new Map();
  for (const [index, step] of steps.entries()) {
    const deps = normalizeDependsOn(step.dependsOn);
    graph.set(step.id, deps);
    deps.forEach((dep) => {
      if (!ids.has(dep)) errors.push(`execution.workflow.steps[${index}].dependsOn references unknown step: ${dep}`);
    });
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path = []) {
    if (!id || visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`execution.workflow has circular dependency: ${[...path, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const dep of graph.get(id) || []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}

function validateKnownTemplates(step, command, prefix, errors) {
  const paramNames = new Set(Object.keys(command.parameters || {}));
  for (const expr of findTemplateExpressions(step)) {
    if (/^[a-zA-Z0-9_]+$/.test(expr) && !paramNames.has(expr)) errors.push(`${prefix} references unknown parameter template: ${expr}`);
    if (expr.startsWith('params.') && !paramNames.has(expr.slice('params.'.length))) errors.push(`${prefix} references unknown parameter template: ${expr}`);
  }
}

function normalizeDependsOn(dependsOn) {
  if (!dependsOn) return [];
  return Array.isArray(dependsOn) ? dependsOn : [dependsOn];
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

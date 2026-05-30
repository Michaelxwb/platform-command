import { loadCommand } from './command_store.js';
import { UI_ACTIONS } from './workflow.js';

const REQUIRED_TOP_LEVEL = ['name', 'platform', 'description', 'riskLevel', 'parameters', 'execution', 'successCriteria'];
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const STEP_TYPES = new Set(['api', 'ui', 'manual']);

export function verifyCommand(commandName) {
  const { file, command } = loadCommand(commandName);
  const errors = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in command)) errors.push(`Missing required top-level field: ${key}`);
  }
  if (command.riskLevel && !RISK_LEVELS.has(command.riskLevel)) {
    errors.push('riskLevel must be one of low, medium, high');
  }
  if (!command.parameters || typeof command.parameters !== 'object' || Array.isArray(command.parameters)) {
    errors.push('parameters must be an object');
  } else {
    for (const [name, spec] of Object.entries(command.parameters)) {
      if (!spec.type) errors.push(`parameters.${name}.type is required`);
      if (spec.default !== undefined && spec.required === true) {
        errors.push(`parameters.${name} cannot be both required and have default`);
      }
    }
  }
  if (!command.execution || !Array.isArray(command.execution.prefer)) {
    errors.push('execution.prefer must be an array, e.g. ["api", "ui", "workflow"]');
  }
  if (command.execution?.workflow) validateWorkflow(command.execution.workflow, errors);
  if (!Array.isArray(command.successCriteria) || command.successCriteria.length === 0) {
    errors.push('successCriteria must be a non-empty array');
  }
  return { ok: errors.length === 0, file, errors, command };
}

function validateWorkflow(workflow, errors) {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push('execution.workflow.steps must be a non-empty array');
    return;
  }
  const ids = new Set();
  workflow.steps.forEach((step, index) => {
    const prefix = `execution.workflow.steps[${index}]`;
    if (!step.id) errors.push(`${prefix}.id is required`);
    if (step.id && ids.has(step.id)) errors.push(`${prefix}.id must be unique`);
    if (step.id) ids.add(step.id);
    const type = step.type || (step.ui ? 'ui' : step.request ? 'api' : 'manual');
    if (!STEP_TYPES.has(type)) errors.push(`${prefix}.type must be api, ui, or manual`);
    if (type === 'api' && !step.request) errors.push(`${prefix}.request is required for api step`);
    if (type === 'ui') validateUiStep(step, prefix, errors);
    if (step.retry && typeof step.retry !== 'object') errors.push(`${prefix}.retry must be an object`);
    if (step.extract && typeof step.extract !== 'object') errors.push(`${prefix}.extract must be an object`);
  });
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
    const actionType = action.action || action.type;
    if (!UI_ACTIONS.has(actionType)) errors.push(`${prefix}.ui.actions[${actionIndex}].action is unsupported: ${actionType}`);
  });
}

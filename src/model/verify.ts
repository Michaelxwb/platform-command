// @ts-nocheck
import { loadCommand } from './command_store.js';
import { UI_ACTIONS, findTemplateExpressions, normalizeRecipe, normalizeDependsOn } from '../engine/workflow.js';
import { ACCEPTANCE_TYPES, normalizeAcceptanceCriteria } from './acceptance.js';
import { normalizeCapability } from '../io/exporters.js';
import { JSON_CAPABILITIES } from '../engine/capabilities.js';

const REQUIRED_TOP_LEVEL = ['name', 'platform', 'description', 'riskLevel', 'parameters'];
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const STEP_TYPES = new Set(['api', 'ui', 'manual', 'command']);
const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);
const NL_EXTRACT_TYPES = new Set(['regex', 'number', 'enum', 'url', 'after', 'booleanKeyword']);
const STEP_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function verifyCommand(commandName, options = {}) {
  const { file, command } = loadCommand(commandName, { commandsDir: options.commandsDir });
  const errors = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in command)) errors.push(`Missing required top-level field: ${key}`);
  }
  if (command.riskLevel && !RISK_LEVELS.has(command.riskLevel)) {
    errors.push('riskLevel must be one of low, medium, high');
  }
  validateParameters(command, errors);
  validateNaturalLanguage(command, errors);
  validateDataSource(command, errors);
  validateOutput(command, errors);
  validateAcceptance(command, errors);
  const recipe = normalizeRecipe(command);
  if (recipe) {
    validateWorkflow(recipe, command, errors, recipe.kind === 'recipe' ? 'steps' : 'execution.workflow.steps');
    if (!Array.isArray(recipe.checks)) errors.push('checks must be an array when provided');
  } else {
    if (!command.execution || !Array.isArray(command.execution.prefer)) {
      errors.push('execution.prefer must be an array, e.g. ["api", "ui", "workflow"], or define top-level steps for a lightweight recipe');
    }
    if (command.execution?.workflow) validateWorkflow(command.execution.workflow, command, errors);
  }
  return { ok: errors.length === 0, file, command, errors };
}

function validateAcceptance(command, errors) {
  const criteria = normalizeAcceptanceCriteria(command);
  if (!Array.isArray(criteria)) {
    errors.push('acceptance.criteria must be an array');
    return;
  }
  criteria.forEach((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) {
      errors.push(`acceptance.criteria[${index}] must be an object`);
      return;
    }
    if (!criterion.type) errors.push(`acceptance.criteria[${index}].type is required`);
    else if (!ACCEPTANCE_TYPES.has(criterion.type)) errors.push(`acceptance.criteria[${index}].type is unsupported: ${criterion.type}`);
    if (!criterion.expect && !criterion.message && !criterion.description && criterion.type === 'manual_check') errors.push(`acceptance.criteria[${index}].message is required for manual_check`);
    validateKnownParameterTemplates(criterion, command, `acceptance.criteria[${index}]`, errors);
  });
}

function validateDataSource(command, errors) {
  if (command.dataSource === undefined) return;
  const dataSource = command.dataSource;
  if (!dataSource || typeof dataSource !== 'object' || Array.isArray(dataSource)) {
    errors.push('dataSource must be an object');
    return;
  }
  if (!dataSource.type) errors.push('dataSource.type is required');
  if (dataSource.type === 'builtin' && !dataSource.handler) errors.push('dataSource.handler is required when dataSource.type is builtin');
  if (dataSource.type === 'inline' && dataSource.rows !== undefined && !Array.isArray(dataSource.rows)) errors.push('dataSource.rows must be an array when dataSource.type is inline');
  if (dataSource.type === 'http_json' && (!Array.isArray(dataSource.steps) || dataSource.steps.length === 0)) errors.push('dataSource.steps must be a non-empty array when dataSource.type is http_json');
  validateKnownParameterTemplates(dataSource, command, 'dataSource', errors);
}

function validateOutput(command, errors) {
  if (command.output === undefined) return;
  const output = command.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    errors.push('output must be an object');
    return;
  }
  if (!output.capability) errors.push('output.capability is required');
  if (output.capability && typeof output.capability === 'string' && !output.capability.includes('{{') && output.capability !== 'download' && !normalizeCapability(output.capability) && !JSON_CAPABILITIES.has(output.capability)) {
    errors.push(`output.capability is unsupported: ${output.capability}`);
  }
  if (!output.path && output.capability !== 'return_json') errors.push('output.path is required');
  if (output.columns !== undefined) {
    if (!Array.isArray(output.columns) || output.columns.length === 0) errors.push('output.columns must be a non-empty array');
    else output.columns.forEach((column, index) => {
      if (!column || typeof column !== 'object' || Array.isArray(column)) errors.push(`output.columns[${index}] must be an object`);
      else {
        if (!column.key) errors.push(`output.columns[${index}].key is required`);
        if (!column.title) errors.push(`output.columns[${index}].title is required`);
      }
    });
  }
  validateKnownParameterTemplates(output, command, 'output', errors);
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
    if (spec.enum && (spec.type === 'array' || spec.type === 'object')) errors.push(`parameters.${name}.enum is only supported for scalar types`);
  }
}


function validateNaturalLanguage(command, errors) {
  const nl = command.naturalLanguage;
  if (nl === undefined) return;
  if (!nl || typeof nl !== 'object' || Array.isArray(nl)) {
    errors.push('naturalLanguage must be an object');
    return;
  }
  if (nl.intent !== undefined && typeof nl.intent !== 'string') errors.push('naturalLanguage.intent must be a string');
  for (const field of ['aliases', 'examples']) {
    if (nl[field] !== undefined && (!Array.isArray(nl[field]) || nl[field].some((item) => typeof item !== 'string'))) {
      errors.push(`naturalLanguage.${field} must be an array of strings`);
    }
  }
  if (nl.match !== undefined) validateNaturalLanguageMatch(nl.match, errors);
  if (nl.extract !== undefined) validateNaturalLanguageExtract(nl.extract, command, errors);
}

function validateNaturalLanguageMatch(match, errors) {
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    errors.push('naturalLanguage.match must be an object');
    return;
  }
  for (const field of ['all', 'any', 'verbs']) {
    if (match[field] !== undefined && (!Array.isArray(match[field]) || match[field].some((item) => typeof item !== 'string'))) {
      errors.push(`naturalLanguage.match.${field} must be an array of strings`);
    }
  }
}

function validateNaturalLanguageExtract(extract, command, errors) {
  if (!extract || typeof extract !== 'object' || Array.isArray(extract)) {
    errors.push('naturalLanguage.extract must be an object');
    return;
  }
  const paramNames = new Set(Object.keys(command.parameters || {}));
  for (const [name, rule] of Object.entries(extract)) {
    const prefix = `naturalLanguage.extract.${name}`;
    if (!paramNames.has(name)) errors.push(`${prefix} references unknown parameter`);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!rule.type) errors.push(`${prefix}.type is required`);
    if (rule.type && !NL_EXTRACT_TYPES.has(rule.type)) errors.push(`${prefix}.type is unsupported: ${rule.type}`);
    if (['regex', 'number', 'enum', 'url'].includes(rule.type) && !rule.pattern) errors.push(`${prefix}.pattern is required for ${rule.type}`);
    if (rule.pattern !== undefined) validateRegex(rule.pattern, `${prefix}.pattern`, errors);
    if (rule.fallbackPattern !== undefined) validateRegex(rule.fallbackPattern, `${prefix}.fallbackPattern`, errors);
    if (rule.group !== undefined && !['string', 'number'].includes(typeof rule.group)) errors.push(`${prefix}.group must be a string or number`);
    if (rule.type === 'enum' && rule.map !== undefined && (!rule.map || typeof rule.map !== 'object' || Array.isArray(rule.map))) errors.push(`${prefix}.map must be an object`);
    if (rule.type === 'booleanKeyword') {
      for (const field of ['true', 'false']) {
        if (rule[field] !== undefined && (!Array.isArray(rule[field]) || rule[field].some((item) => typeof item !== 'string'))) {
          errors.push(`${prefix}.${field} must be an array of strings`);
        }
      }
    }
    const param = command.parameters?.[name];
    if (rule.default !== undefined && param?.type && !matchesType(rule.default, param.type)) errors.push(`${prefix}.default must match parameter type ${param.type}`);
  }
}

function validateRegex(pattern, prefix, errors) {
  if (typeof pattern !== 'string') {
    errors.push(`${prefix} must be a string`);
    return;
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    errors.push(`${prefix} must be a valid RegExp: ${error.message}`);
  }
}

function validateWorkflow(workflow, command, errors, stepsPath = 'execution.workflow.steps') {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push(`${stepsPath} must be a non-empty array`);
    return;
  }
  const ids = new Set();
  const stepTypes = new Map();
  workflow.steps.forEach((step, index) => {
    const prefix = `${stepsPath}[${index}]`;
    if (!step.id) errors.push(`${prefix}.id is required`);
    if (step.id && !STEP_ID_PATTERN.test(step.id)) errors.push(`${prefix}.id must start with a letter and contain only letters, numbers, _ or -`);
    if (step.id && ids.has(step.id)) errors.push(`${prefix}.id must be unique`);
    if (step.id) ids.add(step.id);
    const type = step.type || (step.command ? 'command' : step.ui ? 'ui' : step.request ? 'api' : 'manual');
    stepTypes.set(step.id, type);
    if (!STEP_TYPES.has(type)) errors.push(`${prefix}.type must be api, ui, manual, or command`);
    if (type === 'api') validateApiStep(step, prefix, errors);
    if (type === 'ui') validateUiStep(step, prefix, errors);
    if (type === 'command' && (typeof step.command !== 'string' || !step.command)) errors.push(`${prefix}.command (referenced command name) is required for command step`);
    if (type === 'command' && step.params !== undefined && (typeof step.params !== 'object' || Array.isArray(step.params))) errors.push(`${prefix}.params must be an object`);
    if (type === 'manual' && !step.manual && !step.instruction) errors.push(`${prefix}.manual or .instruction is required for manual step`);
    if (step.retry && typeof step.retry !== 'object') errors.push(`${prefix}.retry must be an object`);
    if (step.extract && (typeof step.extract !== 'object' || Array.isArray(step.extract))) errors.push(`${prefix}.extract must be an object`);
    // forEach 步的 `as` 别名是循环内绑定（非命令参数），其模板引用对该步放行。
    const allowed = step.forEach !== undefined ? new Set([step.as || 'item']) : null;
    validateKnownTemplates(step, command, prefix, errors, allowed);
  });
  validateDependencies(workflow.steps, ids, errors, stepsPath);
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

function validateDependencies(steps, ids, errors, stepsPath = 'execution.workflow.steps') {
  const graph = new Map();
  for (const [index, step] of steps.entries()) {
    const deps = normalizeDependsOn(step.dependsOn);
    graph.set(step.id, deps);
    deps.forEach((dep) => {
      if (!ids.has(dep)) errors.push(`${stepsPath}[${index}].dependsOn references unknown step: ${dep}`);
    });
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path = []) {
    if (!id || visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`workflow has circular dependency: ${[...path, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const dep of graph.get(id) || []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}

function validateKnownTemplates(step, command, prefix, errors, allowed = null) {
  validateKnownParameterTemplates(step, command, prefix, errors, allowed);
}

function validateKnownParameterTemplates(value, command, prefix, errors, allowed = null) {
  const paramNames = new Set(Object.keys(command.parameters || {}));
  for (const expr of findTemplateExpressions(value)) {
    if (allowed && (allowed.has(expr) || allowed.has(expr.split('.')[0]))) continue;
    if (/^[a-zA-Z0-9_]+$/.test(expr) && !paramNames.has(expr)) errors.push(`${prefix} references unknown parameter template: ${expr}`);
    if (expr.startsWith('params.') && !paramNames.has(expr.slice('params.'.length))) errors.push(`${prefix} references unknown parameter template: ${expr}`);
  }
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

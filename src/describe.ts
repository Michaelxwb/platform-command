// @ts-nocheck
import { listCommands, loadCommand } from './command_store.js';
import { resolveCommandParams } from './params_resolver.js';
import { planCommand, getExecutionCapability } from './execute.js';
import { parseNaturalLanguage } from './nl.js';
import { redactSensitive } from './utils.js';

export function describeCommand(commandName, options = {}) {
  const { command, file, metadata } = loadCommand(commandName, { commandsDir: options.commandsDir });
  const params = options.params || {};
  let paramResolution = null;
  let missingRequired = [];
  try {
    paramResolution = resolveCommandParams(command, params);
    missingRequired = requiredMissing(command, paramResolution.params || {});
  } catch (error) {
    paramResolution = { error: error.message };
    missingRequired = requiredMissing(command, params);
  }
  const dryRun = safeDryRun(command.name, params, options);
  return redactSensitive({
    name: command.name,
    platform: command.platform || null,
    description: command.description || '',
    file,
    metadata,
    riskLevel: command.riskLevel || 'unknown',
    auth: command.auth || command.authentication || null,
    parameters: command.parameters || {},
    defaults: command.defaultConfig || command.defaults || null,
    paramResolution,
    missingRequired,
    capability: getExecutionCapability(command),
    executionModes: Object.keys(command.execution || {}),
    successCriteria: command.successCriteria || [],
    failureCases: command.failureCases || [],
    naturalLanguage: command.naturalLanguage || null,
    dryRunPlan: dryRun
  });
}

export function explainNaturalLanguage(input, options = {}) {
  const parsed = parseNaturalLanguage(input, options);
  const described = describeCommand(parsed.command, { ...options, params: parsed.params });
  const clarification = buildClarification(described);
  return {
    input,
    parsed,
    selectedCommand: parsed.command,
    confidence: parsed.confidence,
    params: parsed.params,
    clarification,
    command: described
  };
}

export function buildAgentManifest(options = {}) {
  const commands = listCommands({ detailed: true, commandsDir: options.commandsDir }).map((item) => ({
    name: item.name,
    platform: item.platform || null,
    description: item.description || '',
    riskLevel: item.riskLevel || 'unknown',
    source: item.source,
    package: item.package,
    parameters: Object.fromEntries(Object.entries(item.parameters || {}).map(([name, spec]) => [name, {
      type: spec.type || 'string',
      required: !!spec.required,
      description: spec.description || '',
      enum: spec.enum || undefined,
      default: spec.default
    }]))
  }));
  return {
    schemaVersion: 'platform-command.agent.v1',
    generatedAt: new Date().toISOString(),
    safeUsage: ['prefer describe before execute', 'prefer dry-run before real execution', 'real external write operations require explicit confirmation'],
    commands
  };
}

function safeDryRun(commandName, params, options) {
  try {
    return planCommand(commandName, params, { commandsDir: options.commandsDir });
  } catch (error) {
    return { status: 'unavailable', error: error.message };
  }
}

function requiredMissing(command, params) {
  return Object.entries(command.parameters || {})
    .filter(([name, spec]) => spec.required && !Object.prototype.hasOwnProperty.call(params || {}, name))
    .map(([name, spec]) => ({ name, description: spec.description || '', type: spec.type || 'string' }));
}

function buildClarification(described) {
  if (!described.missingRequired?.length) return { required: false, questions: [] };
  return {
    required: true,
    questions: described.missingRequired.map((item) => ({
      param: item.name,
      question: `请提供 ${item.name}${item.description ? `（${item.description}）` : ''}`
    }))
  };
}

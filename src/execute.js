import { commandResourceRoot, loadCommand } from './command_store.js';
import { resolveCommandParams } from './params_resolver.js';
import { buildWorkflowPlan, normalizeRecipe, renderValue } from './workflow.js';
import { describeSessionRef } from './session.js';
import { redactSensitive } from './utils.js';
import { executeAutoCapability, hasAutoCapability } from './capabilities.js';

export async function executeCommand(commandName, providedParams = {}, options = {}) {
  const { file, command } = loadCommand(commandName, { commandsDir: options.commandsDir });
  const { params, meta: paramsMeta } = resolveCommandParams(command, providedParams);
  const dryRun = options.dryRun !== false;
  const plan = buildExecutionPlan(command, params, { failOnUnresolvedTemplates: options.dryRun === false });
  if (dryRun) {
    return {
      status: 'dry_run',
      file,
      command: command.name,
      riskLevel: command.riskLevel,
      params: redactSensitive(params),
      paramsMeta: redactSensitive(paramsMeta),
      session: describeSessionRef(plan.sessionRef || command.sessionRef),
      plan
    };
  }
  if (!options.confirm) throw new Error('Real execution is disabled unless --confirm is provided. High-risk steps may require additional confirmation.');
  if (hasAutoCapability(command)) return executeAutoCapability(command, params, { commandDir: commandResourceRoot(file), paramsMeta });
  throw new Error('Real execution engine is not enabled in V2; use dry-run workflow plans first.');
}

function buildExecutionPlan(command, params, options = {}) {
  if (normalizeRecipe(command)) {
    return buildWorkflowPlan(command, params, options);
  }
  const prefer = command.execution?.prefer || [];
  const steps = [];
  if (prefer.includes('api') && command.execution.api) {
    steps.push({ type: 'api', request: renderValue(command.execution.api, { params, steps: {} }) });
  }
  if (prefer.includes('ui') && command.execution.ui) {
    steps.push({ type: 'ui', ui: renderLegacyUi(command.execution.ui, params) });
  }
  return {
    kind: 'legacy',
    preferredModes: prefer,
    steps: redactSensitive(steps),
    successCriteria: command.successCriteria,
    failureCases: command.failureCases || []
  };
}

function renderLegacyUi(ui, params) {
  return renderValue(ui, { params, steps: {} });
}

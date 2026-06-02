import { commandResourceRoot, loadCommand } from './command_store.js';
import { resolveCommandParams } from './params_resolver.js';
import { buildWorkflowPlan, normalizeRecipe, renderValue } from './workflow.js';
import { buildAcceptanceContract, initializeAcceptanceEvidence } from './acceptance.js';
import { describeSessionRef } from './session.js';
import { redactSensitive } from './utils.js';
import { executeAutoCapability, hasAutoCapability } from './capabilities.js';

export function getExecutionCapability(command) {
  if (hasAutoCapability(command)) {
    return {
      executable: true,
      engine: 'auto_capability',
      mode: 'auto',
      reason: 'Command has dataSource plus output.capability and can be executed by the built-in capability engine.'
    };
  }
  const recipe = normalizeRecipe(command);
  if (recipe?.steps?.some((step) => step.type === 'api')) {
    return {
      executable: false,
      engine: 'workflow',
      mode: 'api_plan',
      reason: 'Workflow contains API steps but no real workflow execution engine is available yet; dry-run planning is supported.'
    };
  }
  if (recipe?.steps?.some((step) => step.type === 'ui')) {
    return {
      executable: false,
      engine: 'workflow',
      mode: 'ui_plan',
      reason: 'Workflow contains UI steps but no real workflow execution engine is available yet; dry-run planning is supported.'
    };
  }
  return {
    executable: false,
    engine: null,
    mode: 'none',
    reason: 'No real execution engine is available for this command shape; use dry-run workflow plans or add dataSource plus output.capability.'
  };
}

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
  const capability = getExecutionCapability(command);
  if (capability.executable) return executeAutoCapability(command, params, { commandDir: commandResourceRoot(file), paramsMeta });
  throw new Error(`Not executable: ${capability.reason}`);
}

function buildExecutionPlan(command, params, options = {}) {
  const capability = getExecutionCapability(command);
  if (normalizeRecipe(command)) {
    const plan = buildWorkflowPlan(command, params, options);
    return { ...plan, execution: capability };
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
    execution: capability,
    preferredModes: prefer,
    steps: redactSensitive(steps),
    acceptance: buildAcceptanceContract(command),
    acceptanceEvidence: initializeAcceptanceEvidence(command),
    successCriteria: command.successCriteria,
    failureCases: command.failureCases || []
  };
}

function renderLegacyUi(ui, params) {
  return renderValue(ui, { params, steps: {} });
}

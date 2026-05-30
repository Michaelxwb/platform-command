import { loadCommand, mergeParams } from './command_store.js';
import { buildWorkflowPlan, renderValue } from './workflow.js';
import { describeSessionRef } from './session.js';
import { redactSensitive } from './utils.js';

export async function executeCommand(commandName, providedParams = {}, options = {}) {
  const { file, command } = loadCommand(commandName);
  const params = mergeParams(command, providedParams);
  const dryRun = options.dryRun !== false;
  const plan = buildExecutionPlan(command, params);
  if (dryRun) {
    return {
      status: 'dry_run',
      file,
      command: command.name,
      riskLevel: command.riskLevel,
      params: redactSensitive(params),
      session: describeSessionRef(plan.sessionRef || command.sessionRef),
      plan
    };
  }
  if (!options.confirm) throw new Error('Real execution is disabled unless --confirm is provided. High-risk steps may require additional confirmation.');
  throw new Error('Real execution engine is not enabled in V2; use dry-run workflow plans first.');
}

function buildExecutionPlan(command, params) {
  if (command.execution?.workflow) {
    return buildWorkflowPlan(command, params);
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

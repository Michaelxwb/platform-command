import { loadCommand, mergeParams } from './command_store.js';

export async function executeCommand(commandName, providedParams = {}, options = {}) {
  const { file, command } = loadCommand(commandName);
  const params = mergeParams(command, providedParams);
  const dryRun = options.dryRun !== false;
  const plan = buildExecutionPlan(command, params);

  if (command.riskLevel === 'high' && !options.confirm) {
    return {
      status: dryRun ? 'dry_run' : 'blocked',
      reason: 'High-risk command requires explicit confirmation.',
      command: commandName,
      file,
      params,
      plan
    };
  }

  if (dryRun) {
    return { status: 'dry_run', command: commandName, file, params, plan };
  }

  return {
    status: 'not_implemented',
    command: commandName,
    file,
    params,
    plan,
    message: 'Real API/UI execution is intentionally disabled in V1 unless a concrete platform command is learned and confirmed.'
  };
}

export function buildExecutionPlan(command, params) {
  const prefer = command.execution?.prefer || ['api', 'ui'];
  const steps = [];
  for (const mode of prefer) {
    if (mode === 'api' && command.execution?.api) {
      steps.push({ mode: 'api', request: renderApi(command.execution.api, params) });
    }
    if (mode === 'ui' && command.execution?.ui) {
      steps.push({ mode: 'ui', steps: command.execution.ui.steps || [] });
    }
  }
  return {
    preferredModes: prefer,
    steps,
    successCriteria: command.successCriteria,
    failureCases: command.failureCases || []
  };
}

function renderApi(api, params) {
  const asString = JSON.stringify(api);
  const rendered = asString.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => String(params[key] ?? ''));
  return JSON.parse(rendered);
}

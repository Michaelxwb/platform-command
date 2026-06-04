// @ts-nocheck
import { commandResourceRoot, loadCommand } from './command_store.js';
import { resolveCommandParams } from './params_resolver.js';
import { buildWorkflowPlan, normalizeRecipe, renderValue } from './workflow.js';
import { buildAcceptanceContract, initializeAcceptanceEvidence, evaluateAcceptance } from './acceptance.js';
import { describeSessionRef } from './session.js';
import { redactSensitive } from './utils.js';
import { executeAutoCapability, hasAutoCapability } from './capabilities.js';
import { recordRun } from './runs.js';

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
    const response = {
      status: 'dry_run',
      file,
      command: command.name,
      riskLevel: command.riskLevel,
      params: redactSensitive(params),
      paramsMeta: redactSensitive(paramsMeta),
      session: describeSessionRef(plan.sessionRef || command.sessionRef),
      plan
    };
    const recorded = recordRun({
      command: command.name,
      status: response.status,
      dryRun: true,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      riskLevel: command.riskLevel,
      params,
      paramsMeta,
      result: response
    });
    return { ...response, runId: recorded.id, runFile: recorded.file };
  }
  if (!options.confirm) throw new Error('Real execution is disabled unless --confirm is provided. High-risk steps may require additional confirmation.');
  const capability = getExecutionCapability(command);
  if (capability.executable) {
    const startedAt = new Date().toISOString();
    try {
      const result = await executeAutoCapability(command, params, { commandDir: commandResourceRoot(file), paramsMeta });
      const acceptance = evaluateAcceptance(command, { evidence: options.evidence || {}, result });
      const response = { ...result, acceptance };
      const recorded = recordRun({
        command: command.name,
        status: runStatusFromAcceptance(response.status, acceptance),
        dryRun: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        riskLevel: command.riskLevel,
        params,
        paramsMeta,
        result: response
      });
      return { ...response, runId: recorded.id, runFile: recorded.file };
    } catch (err) {
      const recorded = recordRun({
        command: command.name,
        status: 'error',
        dryRun: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        riskLevel: command.riskLevel,
        params,
        paramsMeta,
        error: err.message
      });
      err.runId = recorded.id;
      err.runFile = recorded.file;
      throw err;
    }
  }
  throw new Error(`Not executable: ${capability.reason}`);
}

function buildExecutionPlan(command, params, options = {}) {
  const capability = getExecutionCapability(command);
  if (normalizeRecipe(command)) {
    const plan = buildWorkflowPlan(command, params, options);
    return {
      ...plan,
      execution: capability,
      acceptance: buildAcceptanceContract(command),
      acceptanceEvidence: initializeAcceptanceEvidence(command)
    };
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

// Synchronous, side-effect-free dry-run plan. Read-only callers (describe /
// doctor) use this instead of executeCommand so they neither write run records
// nor leak unhandled promise rejections when required params are missing.
export function planCommand(commandName, providedParams = {}, options = {}) {
  const { file, command } = loadCommand(commandName, { commandsDir: options.commandsDir });
  const { params, meta: paramsMeta } = resolveCommandParams(command, providedParams);
  const plan = buildExecutionPlan(command, params, { failOnUnresolvedTemplates: false });
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

function runStatusFromAcceptance(execStatus, acceptance) {
  if (acceptance?.status === 'failed') return 'failed';
  if (acceptance?.status === 'incomplete') return 'incomplete';
  return execStatus || 'success';
}

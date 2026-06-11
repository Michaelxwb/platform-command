// @ts-nocheck
import { commandResourceRoot, loadCommand } from './command_store.js';
import { resolveCommandParams } from './params_resolver.js';
import { buildWorkflowPlan, normalizeRecipe, renderValue } from './workflow.js';
import { buildAcceptanceContract, initializeAcceptanceEvidence, evaluateAcceptance } from './acceptance.js';
import { describeSessionRef } from './session.js';
import { redactSensitive } from './utils.js';
import { commandTargetUrl, executeAutoCapability, hasAutoCapability } from './capabilities.js';
import { recordRun } from './runs.js';
import { inferRequirements } from './requirements.js';
import { resolveServerMode } from './server_mode.js';
import { hasUiExecution, executeUiActions } from './ui_executor.js';

export function getExecutionCapability(command) {
  if (hasAutoCapability(command)) {
    return {
      executable: true,
      engine: 'auto_capability',
      mode: 'auto',
      reason: 'Command has dataSource plus output.capability and can be executed by the built-in capability engine.'
    };
  }
  // UI-execution commands (legacy execution.ui or workflow ui steps) run via the
  // Playwright adapter, but only in server mode with a configured storageState
  // session. Outside server mode the engine has no logged-in browser, so it
  // stays a dry-run-only plan (local webbridge has no UI driver here).
  if (hasUiExecution(command)) {
    if (resolveServerMode().storageStatePath) {
      return {
        executable: true,
        engine: 'playwright_ui',
        mode: 'ui',
        reason: 'UI command executes via the Playwright adapter under the user storageState session.'
      };
    }
    return {
      executable: false,
      engine: 'workflow',
      mode: 'ui_plan',
      reason: 'UI command requires a server-mode storageState session (PLATFORM_COMMAND_STORAGE_STATE); dry-run planning is supported.'
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
    const readiness = await checkReadiness(command);
    const response = {
      status: 'dry_run',
      file,
      command: command.name,
      riskLevel: command.riskLevel,
      params: redactSensitive(params),
      paramsMeta: redactSensitive(paramsMeta),
      requirements: readiness.requirements,
      readiness: readiness.status,
      session: describeSessionRef(plan.sessionRef || command.sessionRef),
      plan,
      // 显式告知这是预演、以及如何真正执行——避免调用方（尤其 Agent）误以为已执行、
      // 或反复试 --confirm/--approve 却始终停在 dry_run。
      note: '这是 dry-run 预演，未真正执行。真实执行请加 --execute-real --confirm（二者缺一不可）。',
      realRunHint: `platform-command execute --command ${command.name} --execute-real --confirm ${Object.keys(command.parameters || {}).map((n) => `${n}=...`).join(' ')}`.trim()
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
      const result = capability.engine === 'playwright_ui'
        ? await executeUiActions(command, params, { commandDir: commandResourceRoot(file) })
        : await executeAutoCapability(command, params, { commandDir: commandResourceRoot(file), paramsMeta });
      const acceptance = evaluateAcceptance(command, { evidence: options.evidence || {}, result });
      const response = { ...result, acceptance };
      const recorded = recordRun({
        command: command.name,
        status: runStatusFromAcceptance(response.status, acceptance),
        dryRun: false,
        adapter: response.adapter,
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
    } finally {
      // Lazily launched headless browser must not keep one-shot CLI runs alive.
      const { closePlaywright } = await import('./playwright_adapter.js');
      await closePlaywright();
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

// Quick adapter availability check for dry-run readiness reporting.
// Never throws — returns a status object so the caller can surface it to the user.
// Local mode (no server env) keeps the historical webbridge probe untouched.
async function checkReadiness(command) {
  const requirements = inferRequirements(command);
  const adapters = { nodeHttp: true, webbridge: false };
  const blockers = [];

  if (requirements.session || requirements.ui) {
    let serverMode = null;
    try {
      serverMode = resolveServerMode();
    } catch (err) {
      blockers.push(err.message);
    }
    if (serverMode?.storageStatePath) await checkPlaywrightReadiness(command, adapters, blockers, serverMode);
    else if (serverMode) await checkWebbridgeReadiness(command, adapters, blockers);
  }

  return {
    requirements,
    status: {
      ready: blockers.length === 0,
      adapters,
      blockers
    }
  };
}

async function checkWebbridgeReadiness(command, adapters, blockers) {
  try {
    const { checkWebbridge } = await import('./webbridge.js');
    const wb = await checkWebbridge();
    adapters.webbridge = wb.running;
  } catch {
    adapters.webbridge = false;
  }
  if (!adapters.webbridge) {
    const hint = command.runtime?.unauthorizedHint || '';
    blockers.push(`此命令需要浏览器会话（${command.runtime?.auth?.type || 'browser_session'}），但 kimi-webbridge 未运行。${hint ? hint : '请先启动浏览器桥接。'}`);
  }
}

async function checkPlaywrightReadiness(command, adapters, blockers, serverMode) {
  adapters.playwright = false;
  try {
    const { readStorageState } = await import('./playwright_adapter.js');
    readStorageState(serverMode.storageStatePath);
    adapters.playwright = true;
  } catch (err) {
    blockers.push(err.message);
    return;
  }
  const targetUrl = commandTargetUrl(command);
  if (!targetUrl) return;
  const { getSessionState } = await import('./session_state.js');
  const { STORAGE_STATE_IMPORT_GUIDE } = await import('./playwright_adapter.js');
  const state = getSessionState(new URL(targetUrl).hostname);
  if (state.invalid) {
    blockers.push(`登录态已失效（${state.reason || '401/403'}，记录于 ${state.at}）。${STORAGE_STATE_IMPORT_GUIDE}`);
  }
}

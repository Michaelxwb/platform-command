// @ts-nocheck
import { normalizeRecipe, renderValue, normalizeDependsOn } from './workflow.js';
import { executeCommand } from './execute.js';
import { exportRows, normalizeCapability } from '../io/exporters.js';
import { resolveOutputPath } from '../entry/server_mode.js';
import { runWithConcurrency } from '../shared/utils.js';

// 组合工作流执行引擎（FEAT-02）：把一条「业务命令」按其 steps 顺序/依赖执行，
// 每个 command step 递归调用 executeCommand，将上游输出（rows + meta + 显式 extract）
// 写入 context.steps[id] 供下游 params 模板引用。`when` 假值跳过；子步失败中止并回传定位。
//
// 防失控：递归深度上限 + 单步超时（RULE-07 思路：有界，不无限等待）。

const MAX_DEPTH = Number(process.env.PLATFORM_COMMAND_WORKFLOW_MAX_DEPTH || 6);
const STEP_TIMEOUT_MS = Number(process.env.PLATFORM_COMMAND_WORKFLOW_STEP_TIMEOUT_MS || 1800000); // 30min，容纳导出

function isTruthy(value) {
  return !(value === false || value === 'false' || value === '' || value === null || value === undefined || value === 0 || value === '0');
}

function getPath(value, path) {
  if (!path) return undefined;
  const normalized = String(path).replace(/^\$\./, '').replace(/^\$/, '');
  if (!normalized) return value;
  return normalized.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), value);
}

// 依赖拓扑排序（sequential 策略保持声明顺序）。
function orderSteps(steps, strategy) {
  if (strategy === 'sequential') return steps.slice();
  const byId = new Map(steps.filter((s) => s.id).map((s) => [s.id, s]));
  const visited = new Set();
  const ordered = [];
  const visit = (step) => {
    if (!step.id || visited.has(step.id)) return;
    visited.add(step.id);
    for (const dep of normalizeDependsOn(step.dependsOn)) {
      if (byId.has(dep)) visit(byId.get(dep));
    }
    ordered.push(step);
  };
  steps.forEach(visit);
  return ordered;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`workflow step '${label}' 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function executeWorkflow(command, params = {}, options = {}) {
  const depth = options.depth || 0;
  if (depth > MAX_DEPTH) throw new Error(`workflow 递归深度超过上限 ${MAX_DEPTH}（疑似循环组合）`);
  const recipe = normalizeRecipe(command);
  if (!recipe || !Array.isArray(recipe.steps)) throw new Error('executeWorkflow: command has no steps');

  const context = { params, steps: {} };
  const summaries = [];
  const ordered = orderSteps(recipe.steps, recipe.strategy);

  for (const step of ordered) {
    const id = step.id || `step_${summaries.length + 1}`;
    const type = step.type || (step.command ? 'command' : 'manual');

    if (step.when !== undefined && !isTruthy(renderValue(step.when, context))) {
      summaries.push({ id, command: step.command || null, skipped: true, reason: 'when=false' });
      continue;
    }

    // forEach 循环：对列表每项执行同一子命令，可并发（concurrency），收集结果成 rows。
    // 批量语义：单项失败不中止整批（记 __error 继续），适合"批量导出 N 个客户"。
    if (step.forEach) {
      const list = renderValue(step.forEach, context) || [];
      if (!Array.isArray(list)) throw new Error(`forEach '${id}' did not resolve to an array`);
      const concurrency = Math.max(1, Number(renderValue(step.concurrency ?? 1, context)) || 1);
      const as = step.as || 'item';
      const tasks = list.map((item) => async () => {
        const itemCtx = { ...context, [as]: item };
        const subParams = renderValue(step.params || {}, itemCtx);
        const result = await withTimeout(
          executeCommand(step.command, subParams, { dryRun: false, confirm: options.confirm, commandsDir: options.commandsDir, depth: depth + 1, site: options.site }),
          STEP_TIMEOUT_MS, `${id}[forEach]`
        );
        if (result?.acceptance?.status === 'failed') throw new Error('acceptance failed');
        if (step.collect) return getPath(result, step.collect);
        // 不指定 collect 时：展开子结果 meta，并附来源项与状态便于批量追溯。
        return { __item: item, __status: result?.status ?? 'executed', ...(result?.meta || {}) };
      });
      const settled = await runWithConcurrency(tasks, concurrency);
      const collected = [];
      let failures = 0;
      settled.forEach((r, i) => {
        if (r.ok) collected.push(r.value);
        else { failures += 1; collected.push({ __item: list[i], __status: 'failed', __error: r.error }); }
      });
      context.steps[id] = { rows: collected };
      summaries.push({ id, command: step.command, forEach: true, count: list.length, failures, concurrency });
      continue;
    }

    if (type !== 'command') {
      // 组合工作流里非 command 步（manual 备注等）不执行，仅记录。
      summaries.push({ id, type, executed: false, note: '非 command 步，compose 引擎不执行' });
      continue;
    }

    const subParams = renderValue(step.params || {}, context);
    let result;
    try {
      result = await withTimeout(
        executeCommand(step.command, subParams, {
          dryRun: false,
          confirm: options.confirm,
          commandsDir: options.commandsDir,
          depth: depth + 1,
          site: options.site
        }),
        STEP_TIMEOUT_MS,
        id
      );
    } catch (err) {
      summaries.push({ id, command: step.command, status: 'error', error: err.message });
      return { status: 'failed', command: command.name, capability: 'workflow_compose', failedStep: id, steps: summaries };
    }

    // 子步验收失败视为业务失败 → 中止（不静默继续）。
    if (result?.acceptance?.status === 'failed') {
      summaries.push({ id, command: step.command, status: 'failed', reason: 'acceptance failed', acceptance: result.acceptance });
      return { status: 'failed', command: command.name, capability: 'workflow_compose', failedStep: id, steps: summaries };
    }

    const stepContext = { ...(result?.meta || {}), rows: result?.rows ?? [], status: result?.status };
    for (const [key, path] of Object.entries(step.extract || {})) {
      stepContext[key] = getPath(result, typeof path === 'string' ? path : path?.path);
    }
    context.steps[id] = stepContext;
    summaries.push({ id, command: step.command, status: result?.status || 'executed' });
  }

  // 组合末尾可选地把收集到的 rows 交给输出能力（如批量汇总 → export_excel / return_json）。
  if (command.output && command.output.capability && command.output.source !== undefined) {
    const out = renderValue(command.output, context);
    const rows = Array.isArray(out.source) ? out.source : [];
    const cap = normalizeCapability(out.capability);
    if (cap) {
      const result = exportRows({ capability: cap, outputPath: out.path, columns: out.columns, rows, title: out.title || command.description });
      return { status: 'executed', command: command.name, capability: cap, steps: summaries, outputPath: result.outputPath, rows: rows.length };
    }
    if (out.capability === 'return_json' || out.capability === 'save_json') {
      let outputPath = null;
      if (out.capability === 'save_json' && out.path) {
        outputPath = resolveOutputPath(out.path);
        const fs = await import('node:fs');
        const path = await import('node:path');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify({ title: out.title, rows }, null, 2)}\n`);
      }
      return { status: 'executed', command: command.name, capability: out.capability, steps: summaries, outputPath, rows };
    }
  }

  const last = summaries.filter((s) => s.command).at(-1);
  return {
    status: 'executed',
    command: command.name,
    capability: 'workflow_compose',
    steps: summaries,
    lastStep: last?.id || null,
    rows: summaries.length
  };
}

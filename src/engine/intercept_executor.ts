// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { renderValue } from './workflow.js';
import { resolveCommandResource } from '../model/command_store.js';

// 浏览器响应拦截执行引擎（FEAT-03）：通用化「拦截改写响应 + 捕获响应 + 轮询」。
// 命令声明 interceptFlow：
//   {
//     url: "<goto url, templated>",
//     gotoTimeoutMs, waitMs,
//     rewrite: [ { urlPattern, set: [ { path, value } ] } ],   // page.route 改写响应体字段
//     capture: [ { urlPattern, extract: { taskId: "data._id" } } ], // page.on('response') 抓字段
//     poll: { url, method, headers, body, itemsPath, matchField, matchValue,
//             readyField, readyValue, failValues, intervalMs, timeoutMs }  // 轮询至就绪/超时
//   }
// 与具体业务解耦——导出只是首个使用者。

export function getPath(value, path) {
  if (!path) return undefined;
  const normalized = String(path).replace(/^\$\./, '').replace(/^\$/, '');
  if (!normalized) return value;
  return normalized.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), value);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  // 拒绝原型链键：rewrite 规格虽来自命令 JSON，但仍杜绝被改写体借 __proto__ 污染原型。
  if (parts.some((p) => UNSAFE_KEYS.has(p))) throw new Error(`setPath: unsafe key in path "${path}"`);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// 纯函数：对响应体文本按 setSpecs 改写指定 JSON 路径，解析失败则原样返回。
export function applyResponseRewrite(bodyText, setSpecs = []) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  for (const spec of setSpecs) setPath(json, spec.path, spec.value);
  return JSON.stringify(json);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 纯逻辑：用注入的 fetchFn 轮询，直到匹配项的 readyField===readyValue（就绪）、
// 命中 failValues（失败）或超时。RULE-07：有 sleep、有超时上限，不忙等。
// matchValue 为空时启用「快照差集」兜底：匹配 matchField 不在 excludeIds（触发前快照）
// 且已就绪的那条新行——用于 capture 没抓到 task_id 时仍能锁定刚生成、且仅这次新增的报告。
export async function pollUntilReady(fetchFn, spec = {}) {
  const interval = Number(spec.intervalMs || 15000);
  const deadline = Date.now() + Number(spec.timeoutMs || 1800000);
  const hasMatchValue = spec.matchValue !== undefined && spec.matchValue !== null && String(spec.matchValue).length > 0;
  const exclude = Array.isArray(spec.excludeIds) ? new Set(spec.excludeIds.map(String)) : null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    let body;
    try {
      body = await fetchFn();
    } catch (err) {
      return { ready: false, error: err.message, polls };
    }
    const items = getPath(body, spec.itemsPath || 'data.list') || [];
    let match = null;
    if (!Array.isArray(items)) match = null;
    else if (hasMatchValue) match = items.find((it) => String(getPath(it, spec.matchField)) === String(spec.matchValue));
    else if (exclude) match = items.find((it) => !exclude.has(String(getPath(it, spec.matchField))) && getPath(it, spec.readyField) === spec.readyValue);
    if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) {
      const head = Array.isArray(items) ? items.slice(0, 5).map((it) => `${getPath(it, spec.matchField)}:${spec.readyField}=${getPath(it, spec.readyField)}`).join(' , ') : '(非数组)';
      console.error(`[debug-poll] #${polls} items=${Array.isArray(items) ? items.length : 0} mode=${hasMatchValue ? 'byId(' + spec.matchValue + ')' : 'snapshotDiff(exclude=' + (exclude ? exclude.size : 0) + ')'} matched=${match ? (spec.readyField + '=' + getPath(match, spec.readyField)) : '无'} | 前5: ${head}`);
    }
    if (match) {
      const v = getPath(match, spec.readyField);
      if (v === spec.readyValue) return { ready: true, task: match, polls, viaFallback: !hasMatchValue };
      if (Array.isArray(spec.failValues) && spec.failValues.includes(v)) {
        return { ready: false, failed: true, task: match, polls };
      }
    }
    if (Date.now() + interval >= deadline) break;
    await sleep(interval);
  }
  return { ready: false, timedOut: true, polls };
}

// 通用 command-local JS 运行器（urlBuilder / rewrite set builder 共用），对称于 bodyBuilder。
async function runCommandModule(builder, ctx, commandDir, defaultExport) {
  if (!commandDir) throw new Error('command module requires commandDir');
  const spec = typeof builder === 'string' ? { module: builder, export: defaultExport } : builder;
  if (!spec.module) throw new Error('command module spec requires .module');
  const moduleUrl = pathToFileURL(resolveCommandResource(commandDir, spec.module));
  if (process.env.PLATFORM_COMMAND_RELOAD_SIGNER === '1') moduleUrl.searchParams.set('t', String(Date.now()));
  const imported = await import(moduleUrl.href);
  const fn = imported[spec.export || defaultExport];
  if (typeof fn !== 'function') throw new Error(`module export not found: ${spec.export || defaultExport} in ${spec.module}`);
  return fn(null, { context: ctx });
}

function urlMatcher(pattern) {
  // 子串匹配（导出接口路径稳定），转 RegExp 供 Playwright page.route 使用。
  return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export async function executeInterceptFlow(command, params = {}, options = {}) {
  const { withPlaywrightPage, fetchViaPlaywright } = await import('../adapter/playwright_adapter.js');
  const { applySiteOrigin } = await import('./site.js');
  const site = options.site;
  const flow = command.interceptFlow || {};
  const ctx = { params, steps: {}, capture: {} };
  // 多站点：导出页与 poll 接口的 origin 按选定 site 改写（cookie 由 storageState 浏览器按 host 自动选）。
  const url = applySiteOrigin(
    flow.urlBuilder
      ? await runCommandModule(flow.urlBuilder, ctx, options.commandDir, 'buildUrl')
      : renderValue(flow.url, ctx),
    site
  );

  // 预计算各 rewrite 的改写规格（value 支持 builder JS，如按 locale 拼 export_locales）。
  const rewrites = [];
  for (const rw of flow.rewrite || []) {
    const setSpecs = [];
    for (const s of rw.set || []) {
      const value = s.builder
        ? await runCommandModule(s.builder, ctx, options.commandDir, 'buildValue')
        : renderValue(s.value, ctx);
      setSpecs.push({ path: renderValue(s.path, ctx), value });
    }
    rewrites.push({ urlPattern: rw.urlPattern, setSpecs });
  }
  const captures = {};

  // 触发前对报告列表打快照（task_id 集合）：capture 漏抓 task_id 时，
  // 用「触发后新增 + 已就绪」的差集锁定刚生成那条，避免死等超时。
  let snapshotIds = [];
  if (flow.poll) {
    const spec0 = renderValue(flow.poll, { ...ctx, capture: {} });
    try {
      const body0 = await fetchViaPlaywright(applySiteOrigin(spec0.url, site), {
        method: spec0.method || 'POST',
        headers: spec0.headers || {},
        body: spec0.body !== undefined ? JSON.stringify(spec0.body) : undefined
      });
      const items0 = getPath(body0, spec0.itemsPath || 'data.list') || [];
      if (Array.isArray(items0)) snapshotIds = items0.map((it) => String(getPath(it, spec0.matchField)));
    } catch (e) { if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 触发前快照失败: ${e.message}`); }
    if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 触发前快照报告数=${snapshotIds.length}`);
  }

  await withPlaywrightPage(async (page) => {
    for (const rw of rewrites) {
      const setSpecs = rw.setSpecs;
      await page.route(urlMatcher(rw.urlPattern), async (route) => {
        try {
          const resp = await route.fetch();
          const text = applyResponseRewrite(await resp.text(), setSpecs);
          await route.fulfill({ response: resp, body: text });
        } catch {
          await route.continue().catch(() => {});
        }
      });
    }

    const pending = new Set((flow.capture || []).map((c) => c.urlPattern));
    page.on('response', async (resp) => {
      const u = resp.url();
      for (const c of flow.capture || []) {
        if (!u.includes(c.urlPattern)) continue;
        try {
          const json = await resp.json();
          for (const [k, p] of Object.entries(c.extract || {})) captures[k] = getPath(json, p);
        } catch { /* non-json response */ }
        pending.delete(c.urlPattern);
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(flow.gotoTimeoutMs || 60000) });
    // 首次加载常 race 出 "specify content first"（SPA 内容没就绪）。给一段宽限,
    // 若没 fire generate_report 就 reload 一次（复刻手动回车）——慢页面/软件渲染下尤其需要。
    const reloadGraceMs = Number(flow.reloadGraceMs || 8000);
    const reloads = Number(flow.reloads ?? 1);
    for (let r = 0; r < reloads; r++) {
      const graceEnd = Date.now() + reloadGraceMs;
      try { while (pending.size && Date.now() < graceEnd) await page.waitForTimeout(500); } catch { break; }
      if (!pending.size) break;
      if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 首次未 fire generate_report，reload 第 ${r + 1} 次`);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: Number(flow.gotoTimeoutMs || 60000) }); } catch { break; }
    }
    const deadline = Date.now() + Number(flow.waitMs || 600000);
    try {
      while (pending.size && Date.now() < deadline) await page.waitForTimeout(500);
    } catch (e) {
      // 页面/浏览器在等待 capture 时被关闭（有些 SPA 生成后自动关页）——不致命：
      // generate_report 多半已发生，后面用 report_status 快照差集兜底仍能拿到。
      if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 等待 capture 时页面关闭(${e.message})，转 report_status 兜底`);
    }
  });

  ctx.capture = captures;
  if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 抓到 generate_report task_id=${captures.taskId || '(未抓到→走快照差集)'}`);

  let poll = null;
  if (flow.poll) {
    const spec = renderValue(flow.poll, ctx); // matchValue 可引用 {{capture.taskId}}
    const haveTaskId = ctx.capture.taskId !== undefined && ctx.capture.taskId !== null && String(ctx.capture.taskId).length > 0;
    if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-intercept] 轮询模式=${haveTaskId ? 'byId(' + ctx.capture.taskId + ')' : 'snapshotDiff'}，开始轮询 report_status...`);
    // 抓到 task_id → 按 id 精确轮询；没抓到 → 清空 matchValue，走快照差集兜底。
    const pollSpec = haveTaskId ? spec : { ...spec, matchValue: '', excludeIds: snapshotIds };
    poll = await pollUntilReady(
      () => fetchViaPlaywright(applySiteOrigin(spec.url, site), {
        method: spec.method || 'POST',
        headers: spec.headers || {},
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined
      }),
      pollSpec
    );
    // 兜底命中：把锁定行的 task_id 回填，供下游（发邮件/同步/下载）使用。
    if (!haveTaskId && poll?.ready && poll.task) captures.taskId = getPath(poll.task, spec.matchField);
  }

  const captureOk = !(flow.capture || []).length || captures.taskId !== undefined;
  const status = flow.poll ? (poll?.ready ? 'executed' : 'failed') : (captureOk ? 'executed' : 'failed');
  return {
    status,
    command: command.name,
    capability: 'ui_intercept',
    adapter: 'playwright',
    rows: [],
    meta: { ...captures, poll }
  };
}

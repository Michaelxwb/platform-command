// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { renderValue } from './workflow.js';
import { exportRows, normalizeCapability } from '../io/exporters.js';
import { readDataSource } from './data_sources.js';
import { inferRequirements } from '../model/requirements.js';
import { resolveOutputPath, resolveServerMode } from '../entry/server_mode.js';

// Select the fetch adapter required by the command and prepare its context.
// Returns { viaBrowser, session, adapter } — the caller passes these into readDataSource.
//
// Decision rule:
//   runtime.auth.type === 'browser_session_cookie'  → primary HTTP path needs
//     httpOnly cookies from a live session:
//       server mode (PLATFORM_COMMAND_STORAGE_STATE set) → headless Playwright;
//       otherwise → webbridge against the user's real browser (local path, unchanged).
//   everything else (plain API, bearer token, UI-only fallback)  → Node fetch
//     is sufficient for the dataSource; UI steps are handled separately.
// 从 storageState 的 cookie 列表里，挑出对 host 生效的，拼成 Cookie 头 + 取 csrf_token。
export function cookieSessionFromState(cookies = [], host) {
  const applies = (domain) => {
    const d = String(domain || '').replace(/^\./, '');
    return d && (host === d || host.endsWith(`.${d}`));
  };
  const matched = (cookies || []).filter((c) => applies(c.domain));
  return {
    cookieHeader: matched.map((c) => `${c.name}=${c.value}`).join('; '),
    csrfToken: (matched.find((c) => c.name === 'csrf_token') || {}).value || ''
  };
}

async function resolveAdapter(command, site) {
  const authType = command.runtime?.auth?.type || '';
  const needsBrowserFetch = authType === 'browser_session_cookie';
  if (!needsBrowserFetch) return { viaBrowser: false, session: {}, adapter: 'node_http' };

  const { applySiteOrigin } = await import('./site.js');
  // 多站点：实际请求的 host 取选定 site（origin 改写后），cookie 选择/会话预热都按它来。
  const targetUrl = applySiteOrigin(commandTargetUrl(command), site);
  if (!targetUrl) {
    throw new Error(
      `此命令需要已登录的浏览器会话（sessionRef: ${command.sessionRef || '?'}），` +
      `但未找到目标 URL（learnedFrom.url 未设置）。` +
      (command.runtime?.unauthorizedHint ? `\n提示: ${command.runtime.unauthorizedHint}` : '')
    );
  }
  // 有 storageState（已含完整 cookie，含 httpOnly）→ 直接 node fetch 注入 Cookie 头，
  // 不启动浏览器。http_json 命令（搜客户/发邮件/同步等）在无 chromium 的 air-gapped 环境也能跑；
  // 浏览器只留给导出（interceptFlow，需 MITM）。与原 skill 用 requests+Cookie 一致。
  const statePath = resolveServerMode().storageStatePath;
  // 强制走浏览器（PLATFORM_COMMAND_FORCE_BROWSER=1）：node 直连用 storageState 里的"静态"csrf，
  // 而 soar 等平台每次加载页面会轮换 csrf_token，旧 csrf 会被判失效（业务码非 0，如 9000）。
  // 这条路先 page.goto 预热刷新 csrf，再用浏览器实时 cookie/csrf 发请求（与导出复用同一条已验证会话）。
  const forceBrowser = process.env.PLATFORM_COMMAND_FORCE_BROWSER === '1' || process.env.PLATFORM_COMMAND_FORCE_BROWSER === 'true';
  if (statePath && forceBrowser) {
    const { ensurePlaywrightSession, resolveSessionFromPlaywright } = await import('../adapter/playwright_adapter.js');
    await ensurePlaywrightSession(targetUrl, { unauthorizedHint: command.runtime?.unauthorizedHint });
    return { viaBrowser: true, adapter: 'playwright', session: await resolveSessionFromPlaywright(targetUrl) };
  }
  if (statePath) {
    const { readStorageState } = await import('../adapter/playwright_adapter.js');
    const host = new URL(targetUrl).hostname;
    const { cookieHeader, csrfToken } = cookieSessionFromState(readStorageState(statePath).cookies, host);
    return { viaBrowser: false, adapter: 'node_http', session: { csrfToken }, cookieHeader };
  }
  // 无 storageState → webbridge（浏览器自动带 cookie）
  const { ensureBrowserSession, resolveSessionFromBrowser } = await import('../adapter/webbridge.js');
  await ensureBrowserSession(targetUrl, { unauthorizedHint: command.runtime?.unauthorizedHint });
  return { viaBrowser: true, session: await resolveSessionFromBrowser(), adapter: 'webbridge' };
}

// Target URL used for session warm-up and per-host session health checks.
export function commandTargetUrl(command) {
  return command.learnedFrom?.url || extractTargetUrl(command) || null;
}

function extractTargetUrl(command) {
  const steps = command.dataSource?.steps || [];
  for (const step of steps) {
    const url = step.request?.url;
    if (url && !url.includes('{{')) {
      try { return new URL(url).origin; } catch { /* skip */ }
    }
  }
  const apiUrl = command.execution?.api?.url;
  if (apiUrl && !apiUrl.includes('{{')) {
    try { return new URL(apiUrl).origin; } catch { /* skip */ }
  }
  return null;
}

export function hasAutoCapability(command) {
  return Boolean(command?.dataSource && command?.output?.capability);
}

export const JSON_CAPABILITIES = new Set(['return_json', 'save_json']);

export async function executeAutoCapability(command, params, options = {}) {
  if (!hasAutoCapability(command)) return null;

  const { viaBrowser, session, adapter, cookieHeader } = await resolveAdapter(command, options.site);

  const context = { params, steps: {}, warnings: [], session };
  const dataSource = renderValue(command.dataSource, context);
  const data = await readDataSource(dataSource, params, { commandDir: options.commandDir, viaBrowser, session, browserAdapter: adapter, cookieHeader, site: options.site });
  context.steps[dataSource.id || 'data'] = { rows: data.rows, title: data.title };

  const output = renderValue(command.output, context);
  const requestedCapability = output.capability || output.format || output.path;
  if (requestedCapability === 'download') {
    const dl = data.meta && data.meta.__download;
    if (!dl) {
      // 响应不是二进制（可能返回 JSON 下载链接或错误）：原样回传，不落地文件，交 agent 判断。
      return { status: 'executed', command: command.name, capability: 'download', adapter, outputPath: null, rows: data.rows, meta: data.meta, note: '响应非二进制（可能是 JSON 链接/错误），未落地文件' };
    }
    const base = resolveOutputPath(output.path || `report-${params.taskId || 'download'}`);
    const outputPath = dl.filename ? path.join(path.dirname(base), dl.filename) : base;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, dl.bytes);
    return { status: 'executed', command: command.name, capability: 'download', adapter, outputPath, bytes: dl.size, filename: dl.filename, contentType: dl.contentType, meta: {} };
  }
  if (JSON_CAPABILITIES.has(requestedCapability)) {
    const payload = {
      title: output.title || data.title || command.description,
      rows: data.rows,
      meta: data.meta || {}
    };
    let outputPath = null;
    if (requestedCapability === 'save_json') {
      if (!output.path) throw new Error('output.path is required for save_json');
      outputPath = resolveOutputPath(output.path);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    }
    return {
      status: 'executed',
      command: command.name,
      capability: requestedCapability,
      adapter,
      outputPath,
      rows: payload.rows,
      meta: payload.meta,
      dataSource: {
        type: dataSource.type,
        handler: dataSource.handler || dataSource.name || null,
        meta: data.meta || {}
      }
    };
  }

  const capability = normalizeCapability(requestedCapability);
  if (!capability) throw new Error(`Unsupported output capability: ${requestedCapability}`);
  const result = exportRows({
    capability,
    outputPath: output.path,
    columns: output.columns,
    rows: data.rows,
    title: output.title || data.title || command.description
  });
  return {
    status: 'executed',
    command: command.name,
    capability: result.capability,
    adapter,
    outputPath: result.outputPath,
    rows: result.rows,
    columns: result.columns,
    dataSource: {
      type: dataSource.type,
      handler: dataSource.handler || dataSource.name || null,
      meta: data.meta || {}
    }
  };
}

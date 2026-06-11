// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { renderValue } from './workflow.js';
import { exportRows, normalizeCapability } from './exporters.js';
import { readDataSource } from './data_sources.js';
import { inferRequirements } from './requirements.js';
import { resolveOutputPath, resolveServerMode } from './server_mode.js';

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
async function resolveAdapter(command) {
  const authType = command.runtime?.auth?.type || '';
  const needsBrowserFetch = authType === 'browser_session_cookie';
  if (!needsBrowserFetch) return { viaBrowser: false, session: {}, adapter: 'node_http' };

  const targetUrl = commandTargetUrl(command);
  if (!targetUrl) {
    throw new Error(
      `此命令需要已登录的浏览器会话（sessionRef: ${command.sessionRef || '?'}），` +
      `但未找到目标 URL（learnedFrom.url 未设置）。` +
      (command.runtime?.unauthorizedHint ? `\n提示: ${command.runtime.unauthorizedHint}` : '')
    );
  }
  if (resolveServerMode().storageStatePath) {
    const { ensurePlaywrightSession, resolveSessionFromPlaywright } = await import('./playwright_adapter.js');
    await ensurePlaywrightSession(targetUrl, { unauthorizedHint: command.runtime?.unauthorizedHint });
    return { viaBrowser: true, session: await resolveSessionFromPlaywright(targetUrl), adapter: 'playwright' };
  }
  const { ensureBrowserSession, resolveSessionFromBrowser } = await import('./webbridge.js');
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

  const { viaBrowser, session, adapter } = await resolveAdapter(command);

  const context = { params, steps: {}, warnings: [], session };
  const dataSource = renderValue(command.dataSource, context);
  const data = await readDataSource(dataSource, params, { commandDir: options.commandDir, viaBrowser, session, browserAdapter: adapter });
  context.steps[dataSource.id || 'data'] = { rows: data.rows, title: data.title };

  const output = renderValue(command.output, context);
  const requestedCapability = output.capability || output.format || output.path;
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

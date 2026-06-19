// @ts-nocheck
import fs from 'node:fs';
import { resolveServerMode } from '../entry/server_mode.js';
import { markSessionInvalid, clearSessionInvalid } from './session_state.js';

// Headless browser adapter for server mode (FEAT-03). Mirrors the webbridge
// function surface so capabilities/data_sources can route to either adapter.
// playwright stays an optionalDependency: it is only imported lazily, and this
// module itself must always be loadable without it (RULE-02).

export const STORAGE_STATE_IMPORT_GUIDE = '请导入登录态：'
  + '本地用 `platform-command session import-cookie --host <平台域名> --cookie "<浏览器Cookie整串>"`（或 `session login --url <登录页>`）创建 storageState，'
  + '并设 PLATFORM_COMMAND_USER_ID 与 PLATFORM_COMMAND_STORAGE_STATE 指向该文件；`session status` 自检。'
  + '服务器/容器用 deploy/import-storage-state.sh <userId> <platform> <file>。';

const defaultLoader = () => import('playwright');
let playwrightLoader = defaultLoader;
let browserPromise = null;
let contextEntry = null; // { statePath, mtimeMs, contextPromise }

// Test seam: inject a fake playwright module. Pass null to restore the real one.
export function __setPlaywrightLoader(loader) {
  playwrightLoader = loader || defaultLoader;
  browserPromise = null;
  contextEntry = null;
}

export function readStorageState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    throw new Error(`storageState 文件不存在: ${statePath || '(未设置)'}。${STORAGE_STATE_IMPORT_GUIDE}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error(`storageState 文件无效（JSON 解析失败）: ${statePath}。${STORAGE_STATE_IMPORT_GUIDE}`);
  }
  if (!Array.isArray(parsed.cookies)) {
    throw new Error(`storageState 文件无效（缺少 cookies 数组）: ${statePath}。${STORAGE_STATE_IMPORT_GUIDE}`);
  }
  return parsed;
}

async function loadPlaywright() {
  try {
    return await playwrightLoader();
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(err?.message || '')) {
      throw new Error('Playwright 适配器不可用：未安装可选依赖 playwright。请在运行环境安装后重试（npm i playwright）。');
    }
    throw err;
  }
}

// 浏览器启动参数：air-gapped/无 bundled chromium 环境可用系统 Chrome——
// PLATFORM_COMMAND_CHROME_PATH 指定可执行文件路径（优先），或 PLATFORM_COMMAND_CHROME_CHANNEL='chrome' 用已装渠道。
// 都不设时用 Playwright 自带的 chromium（生产容器镜像已烤入），行为不变。
export function chromeLaunchOptions(base = {}) {
  const opts = { ...base };
  // PLATFORM_COMMAND_HEADLESS=false → 有头（本地 Mac 用系统 Chrome 时无头不稳，需有头）。
  if (process.env.PLATFORM_COMMAND_HEADLESS === 'false') opts.headless = false;
  if (process.env.PLATFORM_COMMAND_CHROME_PATH) opts.executablePath = process.env.PLATFORM_COMMAND_CHROME_PATH;
  else if (process.env.PLATFORM_COMMAND_CHROME_CHANNEL) opts.channel = process.env.PLATFORM_COMMAND_CHROME_CHANNEL;
  // 禁用 GPU：受管/虚拟/沙箱环境(如 UEM Mac)无可用 GPU，GPU 进程会崩(exit_code=5,
  // "GPU process isn't usable")拖垮整个浏览器。统一禁 GPU + 软件光栅，headed/headless 都稳。
  // 需额外参数(如某些环境要 --no-sandbox/--single-process)用 PLATFORM_COMMAND_CHROME_ARGS 追加。
  const extra = process.env.PLATFORM_COMMAND_CHROME_ARGS ? process.env.PLATFORM_COMMAND_CHROME_ARGS.split(/\s+/).filter(Boolean) : [];
  // 只禁硬件 GPU（避免 GPU 进程崩），保留软件渲染兜底（图表/canvas 仍能渲）。
  // 仍崩可再用 PLATFORM_COMMAND_CHROME_ARGS 追加 --disable-software-rasterizer / --single-process 等。
  opts.args = [...(base.args || []), '--disable-gpu', ...extra];
  return opts;
}

async function ensureBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing?.isConnected()) return existing;
    browserPromise = null;
    contextEntry = null;
  }
  browserPromise = loadPlaywright().then((pw) => pw.chromium.launch(chromeLaunchOptions({ headless: true })));
  return browserPromise;
}

function storageStatePathOrThrow() {
  const statePath = resolveServerMode().storageStatePath;
  if (!statePath) throw new Error('Playwright 适配器需要 PLATFORM_COMMAND_STORAGE_STATE 指向 storageState 文件。');
  return statePath;
}

// One BrowserContext per storageState file; recreated when the file changes
// on disk so a re-import (CLI-02) takes effect without restarting the process.
async function ensureContext() {
  const statePath = storageStatePathOrThrow();
  readStorageState(statePath);
  const mtimeMs = fs.statSync(statePath).mtimeMs;
  if (contextEntry && contextEntry.statePath === statePath && contextEntry.mtimeMs === mtimeMs) {
    const browser = await browserPromise?.catch(() => null);
    if (browser?.isConnected()) return contextEntry.contextPromise;
    contextEntry = null;
  }
  const browser = await ensureBrowser();
  const stale = contextEntry;
  contextEntry = {
    statePath,
    mtimeMs,
    contextPromise: (async () => {
      if (stale) {
        try { await (await stale.contextPromise).close(); } catch { /* already gone */ }
      }
      return browser.newContext({ storageState: statePath });
    })()
  };
  return contextEntry.contextPromise;
}

// Equivalent of webbridge.fetchViaWebbridge: request with the user's session
// cookies attached. 401/403 marks the host session invalid (FEAT-05).
export async function fetchViaPlaywright(url, init = {}) {
  const context = await ensureContext();
  const host = new URL(url).hostname;
  const response = await context.request.fetch(url, {
    method: init.method || 'GET',
    headers: init.headers || {},
    data: init.body,
    timeout: Number(init.timeoutMs || 30000),
    failOnStatusCode: false
  });
  const status = response.status();
  if ([401, 403].includes(status)) {
    markSessionInvalid(host, `HTTP ${status} for ${url}`);
    const err = new Error(`HTTP ${status} for ${url} - 登录态已失效。${STORAGE_STATE_IMPORT_GUIDE}`);
    err.status = status;
    err.authRequired = true;
    throw err;
  }
  if (!response.ok()) {
    const err = new Error(`HTTP ${status} for ${url}`);
    err.status = status;
    throw err;
  }
  clearSessionInvalid(host);
  return response.json();
}

// Equivalent of webbridge.ensureBrowserSession: warm up the target page so
// SPA platforms refresh their session state before API calls.
export async function ensurePlaywrightSession(targetUrl, options = {}) {
  const context = await ensureContext();
  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  if (!sameTargetPage(page.url ? page.url() : '', targetUrl)) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Number(options.timeoutMs || 20000) });
  }
}

// Equivalent of webbridge.resolveSessionFromBrowser: CSRF token from cookies.
export async function resolveSessionFromPlaywright(targetUrl = '') {
  try {
    const context = await ensureContext();
    const cookies = await context.cookies(targetUrl ? [targetUrl] : undefined);
    const csrf = cookies.find((cookie) => cookie.name === 'csrf_token');
    return { csrfToken: csrf?.value || '', href: targetUrl || '' };
  } catch {
    return {};
  }
}

// Run a callback with a Page from the shared (storageState-backed) context, so
// UI-execution commands act under the user's logged-in session. The page is
// closed afterwards; the context/browser stay warm for reuse.
export async function withPlaywrightPage(fn) {
  const context = await ensureContext();
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => { /* already closed */ });
  }
}

// Close the lazily launched browser so one-shot CLI runs can exit cleanly.
export async function closePlaywright() {
  const pending = browserPromise;
  browserPromise = null;
  contextEntry = null;
  const browser = await pending?.catch(() => null);
  if (browser) await browser.close().catch(() => { /* already closed */ });
}

function sameTargetPage(currentHref, targetUrl) {
  try {
    const current = new URL(currentHref);
    const target = new URL(targetUrl);
    return current.hostname === target.hostname
      && current.pathname === target.pathname
      && current.hash === target.hash;
  } catch {
    return false;
  }
}

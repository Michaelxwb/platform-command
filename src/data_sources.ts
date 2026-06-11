// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { renderValue } from './workflow.js';
import { resolveCommandResource } from './command_store.js';

export async function readDataSource(dataSource, params = {}, options = {}) {
  if (dataSource.type === 'inline') {
    return { rows: Array.isArray(dataSource.rows) ? dataSource.rows : [], title: dataSource.title || '', meta: {} };
  }
  if (dataSource.type === 'http_json') return readHttpJsonSource(dataSource, params, options);
  throw new Error(`Unsupported dataSource: ${dataSource.type}${dataSource.handler ? `/${dataSource.handler}` : ''}`);
}

async function readHttpJsonSource(dataSource, params, options) {
  const context = { params, steps: {}, cursor: {}, warnings: [], commandDir: options.commandDir, viaBrowser: !!options.viaBrowser, browserAdapter: options.browserAdapter || 'webbridge', session: options.session || {} };
  let rows = [];
  let title = dataSource.title || '';
  const meta = {};
  for (const step of dataSource.steps || []) {
    if (step.collect) {
      const collected = await collectRows(step, context);
      rows = collected.rows;
      context.steps[step.id] = { rows };
    } else {
      const body = await fetchStepJson(step, context);
      const extracted = extractObject(body, step.extract || {});
      context.steps[step.id] = extracted;
      Object.assign(meta, extracted);
      if (!title && extracted.title) title = extracted.title;
    }
  }
  return { rows, title, meta };
}

async function collectRows(step, context) {
  const collect = step.collect || {};
  const limit = Number(renderValue(collect.limit || 100, context));
  const rows = [];
  context.cursor = { next: collect.initialCursor ?? collect.initialPage ?? 0 };
  let pages = 0;
  while (rows.length < limit && pages < Number(collect.maxPages || 20)) {
    pages += 1;
    context.cursor = {
      ...context.cursor,
      page: collect.pageParam ? pages : context.cursor.page,
      offset: collect.offsetParam ? (pages - 1) * Number(renderValue(collect.pageSize || limit, context) || limit) : context.cursor.offset
    };
    const body = await fetchStepJson(step, context);
    const rawItems = getPath(body, collect.itemsPath || 'data.items') || [];
    const items = rawItems.filter((item) => shouldKeepItem(item, collect));
    rows.push(...items.map((item) => mapItem(item, collect.map || [])));
    const isEnd = Boolean(getPath(body, collect.endPath || 'data.cursor.is_end'));
    const next = getPath(body, collect.nextPath || 'data.cursor.next');
    if (rows.length >= limit || !rawItems.length || isEnd) break;
    if (collect.pageParam || collect.offsetParam) {
      const renderedPageSize = Number(renderValue(collect.pageSize || 0, context));
      if (renderedPageSize > 0 && rawItems.length < renderedPageSize) break;
      context.cursor = { ...context.cursor, next: pages + 1 };
      continue;
    }
    if (next === undefined || next === context.cursor.next) break;
    context.cursor = { next };
  }
  return { rows: rows.slice(0, limit) };
}

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.PLATFORM_COMMAND_FETCH_TIMEOUT_MS || 15000);

async function fetchStepJson(step, context) {
  const request = renderValue(step.request || {}, context);
  const target = new URL(request.url);
  const query = await signQueryWithCommandCode(request.query || {}, request.signer, context);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
  const method = String(request.method || 'GET').toUpperCase();
  const headers = { ...(request.headers || {}) };

  let body;
  if (request.body !== undefined && !['GET', 'HEAD'].includes(method)) {
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
    if (typeof request.body === 'string' || request.body instanceof Uint8Array) body = request.body;
    else {
      body = JSON.stringify(request.body);
      if (!hasContentType) headers['content-type'] = 'application/json';
    }
  }

  if (context.viaBrowser) {
    const fetchViaSession = context.browserAdapter === 'playwright'
      ? (await import('./playwright_adapter.js')).fetchViaPlaywright
      : (await import('./webbridge.js')).fetchViaWebbridge;
    const result = await fetchViaSession(String(target), { method, headers, body, timeoutMs: request.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS });
    const expectedCode = request.expect?.bodyCode;
    if (expectedCode !== undefined && result.code !== expectedCode) throw new Error(`Unexpected body.code ${result.code}: ${result.message || ''}`.trim());
    return result;
  }

  const init = { method, headers, signal: AbortSignal.timeout(Number(request.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS)) };
  if (body !== undefined) init.body = body;
  const response = await fetch(target, init);
  if (!response.ok) {
    const authHint = [401, 403].includes(response.status)
      ? 'Authentication failed or session expired; provide valid session cookies/headers (for example Cookie and X-CSRF-Token) or execute through an authenticated browser adapter.'
      : '';
    const err = new Error(`HTTP ${response.status} for ${target}${authHint ? ` - ${authHint}` : ''}`);
    err.status = response.status;
    err.url = String(target);
    err.authRequired = [401, 403].includes(response.status);
    throw err;
  }
  const responseBody = await response.json();
  const expectedCode = request.expect?.bodyCode;
  if (expectedCode !== undefined && responseBody.code !== expectedCode) throw new Error(`Unexpected body.code ${responseBody.code}: ${responseBody.message || ''}`.trim());
  return responseBody;
}

async function signQueryWithCommandCode(query, signer, context) {
  if (!signer) return query;
  if (!context.commandDir) throw new Error('Command-local signer requires commandDir');
  const spec = typeof signer === 'string' ? { module: signer, export: 'signQuery' } : signer;
  if (!spec.module) throw new Error('request.signer.module is required');
  const modulePath = resolveCommandResource(context.commandDir, spec.module);
  const moduleUrl = pathToFileURL(modulePath);
  // Cache-busting forces a fresh module per import, which leaks the ESM registry
  // in long-running servers. Opt in only when explicitly developing signer code.
  if (process.env.PLATFORM_COMMAND_RELOAD_SIGNER === '1') moduleUrl.searchParams.set('t', String(Date.now()));
  const imported = await import(moduleUrl.href);
  const fn = imported[spec.export || 'signQuery'];
  if (typeof fn !== 'function') throw new Error(`Signer export not found: ${spec.export || 'signQuery'} in ${spec.module}`);
  return fn(query, { context });
}

function shouldKeepItem(item, collect) {
  for (const path of collect.excludeWhenExists || []) {
    if (getPath(item, path) !== undefined) return false;
  }
  return true;
}

function extractObject(body, extract) {
  const out = {};
  for (const [key, spec] of Object.entries(extract)) {
    out[key] = getPath(body, spec.path || spec);
  }
  return out;
}

function mapItem(item, mappings) {
  const out = {};
  for (const mapping of mappings) {
    let value = getPath(item, mapping.path);
    if (mapping.transform === 'unixTime') value = formatUnixTime(value);
    else if (mapping.transform === 'msTime') value = formatUnixTime(Number(value) / 1000);
    else if (mapping.transform === 'number') value = Number(value || 0);
    out[mapping.key] = value ?? '';
  }
  return out;
}

function getPath(value, path) {
  if (!path) return undefined;
  const normalized = String(path).replace(/^\$\./, '').replace(/^\$/, '');
  if (!normalized) return value;
  return normalized.split('.').reduce((current, part) => {
    if (current == null) return undefined;
    return current[part];
  }, value);
}

function formatUnixTime(ctime, locale = 'zh-CN', timeZone = 'Asia/Shanghai') {
  const date = new Date(Number(ctime) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
}

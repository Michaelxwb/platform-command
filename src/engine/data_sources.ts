// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { renderValue } from './workflow.js';
import { resolveCommandResource } from '../model/command_store.js';

// 从 content-disposition 解析下载文件名（支持 RFC5987 的 filename*=UTF-8''xxx 与普通 filename=）。
export function parseDownloadFilename(contentDisposition = '') {
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i.exec(contentDisposition);
  if (!m) return null;
  try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
}

export async function readDataSource(dataSource, params = {}, options = {}) {
  if (dataSource.type === 'inline') {
    return { rows: Array.isArray(dataSource.rows) ? dataSource.rows : [], title: dataSource.title || '', meta: {} };
  }
  if (dataSource.type === 'http_json') return readHttpJsonSource(dataSource, params, options);
  throw new Error(`Unsupported dataSource: ${dataSource.type}${dataSource.handler ? `/${dataSource.handler}` : ''}`);
}

async function readHttpJsonSource(dataSource, params, options) {
  const context = { params, steps: {}, cursor: {}, warnings: [], commandDir: options.commandDir, viaBrowser: !!options.viaBrowser, browserAdapter: options.browserAdapter || 'webbridge', session: options.session || {}, cookieHeader: options.cookieHeader };
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
      if (body && body.__download) {
        meta.__download = body;
        context.steps[step.id] = { download: true, filename: body.filename, size: body.size };
        continue;
      }
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
    if (rows.length >= limit || !rawItems.length || isEnd) break;
    // HATEOAS 风格：响应给的是"下一页完整 URL"（如知乎 paging.next）。直接用它作为
    // 下一次请求的 URL，避免从 URL 里抠游标 token。优先于 token / page / offset 翻页。
    if (collect.nextUrlPath) {
      const nextUrl = getPath(body, collect.nextUrlPath);
      if (!nextUrl || nextUrl === context.cursor.nextUrl) break;
      context.cursor = { ...context.cursor, nextUrl };
      continue;
    }
    const next = getPath(body, collect.nextPath || 'data.cursor.next');
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
  // nextUrl（HATEOAS 翻页）已是完整下一页地址，直接用它，跳过模板 url + query 拼装。
  const target = new URL(context.cursor?.nextUrl || request.url);
  if (!context.cursor?.nextUrl) {
    const query = await signQueryWithCommandCode(request.query || {}, request.signer, context);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, String(value));
  }
  const method = String(request.method || 'GET').toUpperCase();
  const headers = { ...(request.headers || {}) };

  // body 变换钩子（与 query 的 signer 对称）：command-local JS 模块按 params/前序 steps
  // 计算最终请求体（如清洗 logo、把邮箱数组转 [{_id,value}]）。纯模板表达不了的逻辑走这里。
  let bodyObject = request.body;
  if (request.bodyBuilder && !['GET', 'HEAD'].includes(method)) {
    bodyObject = await buildBodyWithCommandCode(bodyObject, request.bodyBuilder, context);
  }

  let body;
  if (bodyObject !== undefined && !['GET', 'HEAD'].includes(method)) {
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
    if (typeof bodyObject === 'string' || bodyObject instanceof Uint8Array) body = bodyObject;
    else {
      body = JSON.stringify(bodyObject);
      if (!hasContentType) headers['content-type'] = 'application/json';
    }
  }

  if (context.viaBrowser) {
    const fetchViaSession = context.browserAdapter === 'playwright'
      ? (await import('../adapter/playwright_adapter.js')).fetchViaPlaywright
      : (await import('../adapter/webbridge.js')).fetchViaWebbridge;
    const result = await fetchViaSession(String(target), { method, headers, body, timeoutMs: request.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS });
    const expectedCode = request.expect?.bodyCode;
    if (expectedCode !== undefined && result.code !== expectedCode) throw new Error(`Unexpected body.code ${result.code}: ${result.message || ''}`.trim());
    return result;
  }

  // 注入 storageState 的 cookie（Plan B：node fetch 直接带 Cookie 头，免启动浏览器）。
  if (context.cookieHeader && !headers.cookie && !headers.Cookie) headers.cookie = context.cookieHeader;
  // 浏览器会话请求补 Origin/Referer：soar 等平台的 CSRF 校验需要同源 Origin/Referer，
  // 浏览器总会带、node fetch 默认不带 → 缺了会 403。按目标 origin 补齐（命令已显式设则不覆盖）。
  if (context.cookieHeader) {
    const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    const origin = new URL(target).origin;
    if (!hasHeader('origin')) headers.Origin = origin;
    if (!hasHeader('referer')) headers.Referer = `${origin}/index.html`;
  }
  const init = { method, headers, signal: AbortSignal.timeout(Number(request.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS)) };
  if (body !== undefined) init.body = body;
  // 诊断开关：PLATFORM_COMMAND_DEBUG_HTTP=1 时打印实际发出的请求要素（不打印 cookie 全文）。
  if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) {
    const ck = headers.cookie || headers.Cookie || '';
    const csrfv = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-csrftoken')?.[1];
    console.error(`[debug-http] ${method} ${target}`);
    console.error(`[debug-http] header keys: ${Object.keys(headers).join(', ')}`);
    console.error(`[debug-http] x-csrftoken: ${csrfv || '(空/未设)'}`);
    console.error(`[debug-http] cookie len=${ck.length} hasSoc=${ck.includes('soc-token')} hasCsrf=${ck.includes('csrf_token')}`);
    console.error(`[debug-http] origin=${headers.Origin || headers.origin || '(无)'} referer=${headers.Referer || headers.referer || '(无)'}`);
    if (body !== undefined) console.error(`[debug-http] body: ${typeof body === 'string' ? body.slice(0, 200) : '(binary)'}`);
  }
  const response = await fetch(target, init);
  if (process.env.PLATFORM_COMMAND_DEBUG_HTTP) console.error(`[debug-http] <- status ${response.status}`);
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
  // 二进制下载分支（如 report_download 返回文件流）：opt-in via request.responseType==='binary'，
  // 不走 JSON 解析，原样返回字节 + content-disposition 文件名，交 download 能力落地。
  if (request.responseType === 'binary') {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      __download: true,
      bytes,
      size: bytes.length,
      contentType: response.headers.get('content-type') || '',
      filename: parseDownloadFilename(response.headers.get('content-disposition') || '')
    };
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

async function buildBodyWithCommandCode(body, builder, context) {
  if (!context.commandDir) throw new Error('Command-local body builder requires commandDir');
  const spec = typeof builder === 'string' ? { module: builder, export: 'buildBody' } : builder;
  if (!spec.module) throw new Error('request.bodyBuilder.module is required');
  const modulePath = resolveCommandResource(context.commandDir, spec.module);
  const moduleUrl = pathToFileURL(modulePath);
  if (process.env.PLATFORM_COMMAND_RELOAD_SIGNER === '1') moduleUrl.searchParams.set('t', String(Date.now()));
  const imported = await import(moduleUrl.href);
  const fn = imported[spec.export || 'buildBody'];
  if (typeof fn !== 'function') throw new Error(`Body builder export not found: ${spec.export || 'buildBody'} in ${spec.module}`);
  return fn(body, { context });
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
    // 列表取单项：从 fromList 数组中找首个满足 where 全等的项，再 pick 字段（或整项）。
    if (spec && typeof spec === 'object' && spec.fromList) {
      const list = getPath(body, spec.fromList);
      const item = Array.isArray(list)
        ? list.find((it) => Object.entries(spec.where || {}).every(([k, v]) => getPath(it, k) === v))
        : undefined;
      out[key] = item === undefined ? undefined : (spec.pick ? getPath(item, spec.pick) : item);
    } else {
      out[key] = getPath(body, spec.path || spec);
    }
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

import path from 'node:path';
import { ROOT, maskHeaders, timestamp, writeJson, redactSensitive } from './utils.js';

export async function learnAction(options) {
  if (!options.url) throw new Error('learn requires --url');
  const provider = options.provider || 'auto';
  if (provider === 'manual') return manualLearn(options, 'requested');
  if (provider === 'http') return httpLearn(options, 'requested');
  try {
    return await playwrightLearn(options);
  } catch (error) {
    if (provider === 'playwright') throw error;
    const fallback = options.fallbackProvider || 'http';
    if (fallback === 'manual') return manualLearn(options, error.message);
    return httpLearn(options, error.message);
  }
}

async function playwrightLearn(options) {
  const platform = options.platform || 'unknown';
  const action = options.action || 'inspect';
  const observeSeconds = Number(options.observeSeconds || 8);
  const runDir = path.join(ROOT, 'runs', `${timestamp()}_${platform}_${action}`);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: options.headless !== false });
  const page = await browser.newPage();
  const requests = [];
  const responses = [];
  const operationTrace = [];

  page.on('request', (request) => {
    requests.push(redactSensitive({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: maskHeaders(request.headers()),
      postData: request.postData() ? '[PRESENT_REDACTED]' : null
    }));
  });
  page.on('response', (response) => {
    responses.push(redactSensitive({
      url: response.url(),
      status: response.status(),
      headers: maskHeaders(response.headers())
    }));
  });

  await page.exposeFunction('__platformCommandRecord', (event) => {
    operationTrace.push(redactSensitive({ ...event, at: new Date().toISOString() }));
  });
  await page.goto(options.url, { waitUntil: 'domcontentloaded' });
  await installTraceHooks(page).catch(() => null);
  await page.waitForTimeout(observeSeconds * 1000);
  const domSummary = await summarizeDom(page);
  const suggestions = buildSuggestions({ platform, action, domSummary, requests });
  const report = baseReport({ platform, action, url: options.url, provider: 'playwright' }, {
    domSummary,
    operationTrace,
    network: { requests, responses },
    candidateParameters: suggestions.candidateParameters,
    suggestedWorkflow: suggestions.suggestedWorkflow
  });
  writeJson(path.join(runDir, 'learn_report.json'), report);
  await page.screenshot({ path: path.join(runDir, 'page.png'), fullPage: true }).catch(() => null);
  await browser.close();
  return { status: 'learned', provider: 'playwright', runDir, report };
}

async function httpLearn(options, reason = 'fallback') {
  const platform = options.platform || 'unknown';
  const action = options.action || 'inspect';
  const runDir = path.join(ROOT, 'runs', `${timestamp()}_${platform}_${action}`);
  const requests = [];
  const responses = [];
  let title = '';
  let bodyPreview = '';
  try {
    const response = await fetch(options.url, { method: 'GET', redirect: 'follow' });
    const text = await response.text();
    title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || '';
    bodyPreview = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    requests.push(redactSensitive({ method: 'GET', url: options.url, resourceType: 'document', headers: {} }));
    responses.push(redactSensitive({ url: response.url, status: response.status, headers: maskHeaders(Object.fromEntries(response.headers.entries())) }));
  } catch (error) {
    responses.push({ url: options.url, status: null, error: error.message });
  }
  const domSummary = { title, url: options.url, inputs: [], buttons: [], links: [], forms: [], bodyPreview };
  const suggestions = buildSuggestions({ platform, action, domSummary, requests });
  const report = baseReport({ platform, action, url: options.url, provider: 'http', fallbackReason: reason }, {
    domSummary,
    operationTrace: [],
    network: { requests, responses },
    candidateParameters: suggestions.candidateParameters,
    suggestedWorkflow: suggestions.suggestedWorkflow,
    fallbackInstructions: [
      'HTTP fallback cannot observe real browser interactions.',
      'Use this report as a skeleton, then add selectors/API calls manually or rerun with Playwright/browser provider.'
    ]
  });
  writeJson(path.join(runDir, 'learn_report.json'), report);
  return { status: 'learned_fallback', provider: 'http', runDir, report };
}

function manualLearn(options, reason = 'fallback') {
  const platform = options.platform || 'unknown';
  const action = options.action || 'inspect';
  const runDir = path.join(ROOT, 'runs', `${timestamp()}_${platform}_${action}`);
  const domSummary = { title: '', url: options.url, inputs: [], buttons: [], links: [], forms: [] };
  const report = baseReport({ platform, action, url: options.url, provider: 'manual', fallbackReason: reason }, {
    domSummary,
    operationTrace: [],
    network: { requests: [], responses: [] },
    candidateParameters: [],
    suggestedWorkflow: {
      name: `${platform}.${action}`,
      sessionRef: 'default-browser-profile',
      strategy: 'sequential',
      steps: [
        { id: 'open_page', type: 'manual', manual: `Open ${options.url} and record the business steps for ${platform}.${action}.` },
        { id: 'convert_steps', type: 'manual', manual: 'Convert observed fields/buttons/API calls into JSON workflow steps, then run verify and dry-run.' }
      ]
    },
    fallbackInstructions: [
      'Manual fallback was used because no browser automation provider was available or requested.',
      'Ask the host agent/user to observe the page and fill selectors/API requests into the command JSON.'
    ]
  });
  writeJson(path.join(runDir, 'learn_report.json'), report);
  return { status: 'learned_fallback', provider: 'manual', runDir, report };
}

function baseReport(meta, data) {
  return {
    platform: meta.platform,
    action: meta.action,
    url: meta.url,
    capturedAt: new Date().toISOString(),
    provider: meta.provider,
    fallbackReason: meta.fallbackReason || null,
    safety: { dryRunOnly: true, submittedActions: false, secretsRedacted: true },
    ...data
  };
}

async function installTraceHooks(page) {
  await page.addInitScript(() => {
    const record = (event) => window.__platformCommandRecord?.(event).catch(() => null);
    document.addEventListener('click', (event) => record({ type: 'click', text: event.target?.innerText || event.target?.value || '', tag: event.target?.tagName }), true);
    document.addEventListener('input', (event) => record({ type: 'input', name: event.target?.name || event.target?.id || '', tag: event.target?.tagName }), true);
    document.addEventListener('submit', (event) => record({ type: 'submit', action: event.target?.action || '', method: event.target?.method || '' }), true);
  });
}

async function summarizeDom(page) {
  return page.evaluate(() => {
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120);
    const selector = (el) => ({
      id: el.id || null,
      name: el.getAttribute('name') || null,
      role: el.getAttribute('role') || null,
      text: text(el) || null,
      ariaLabel: el.getAttribute('aria-label')
    });
    return {
      title: document.title,
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 80).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || null, placeholder: el.placeholder || null, selector: selector(el) })),
      buttons: Array.from(document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')).slice(0, 80).map((el) => ({ text: text(el), selector: selector(el) })),
      links: Array.from(document.querySelectorAll('a')).slice(0, 80).map((el) => ({ text: text(el), href: el.href, selector: selector(el) })),
      forms: Array.from(document.querySelectorAll('form')).slice(0, 40).map((el) => ({ action: el.action, method: el.method, selector: selector(el) }))
    };
  });
}

function buildSuggestions({ platform, action, domSummary, requests }) {
  const candidateParameters = (domSummary.inputs || []).map((input, index) => ({
    name: input.selector.name || input.selector.id?.replace(/[^a-zA-Z0-9_]/g, '_') || `field${index + 1}`,
    source: 'dom.input',
    type: input.type === 'number' ? 'number' : 'string',
    selector: input.selector,
    required: false
  }));
  const apiRequests = requests.filter((req) => ['xhr', 'fetch'].includes(req.resourceType) || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method));
  return {
    candidateParameters,
    suggestedWorkflow: {
      name: `${platform}.${action}`,
      sessionRef: 'default-browser-profile',
      strategy: 'sequential',
      steps: [
        { id: 'open_page', type: 'ui', ui: { url: domSummary.url, actions: [{ action: 'goto', target: domSummary.url }, { action: 'waitFor', selector: { role: 'document' }, timeoutMs: 5000 }] } },
        ...apiRequests.slice(0, 3).map((req, index) => ({ id: `api_${index + 1}`, type: 'api', request: { method: req.method, url: req.url, headers: req.headers }, successWhen: 'status < 400' }))
      ]
    }
  };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    const hint = 'learn provider playwright is optional. Install it with: npm install playwright && npx playwright install chromium';
    const wrapped = new Error(`${hint}. Original error: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

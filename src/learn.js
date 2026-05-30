import path from 'node:path';
import { ROOT, maskHeaders, timestamp, writeJson, redactSensitive } from './utils.js';

export async function learnAction(options) {
  if (!options.url) throw new Error('learn requires --url');
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
  const report = {
    platform,
    action,
    url: options.url,
    capturedAt: new Date().toISOString(),
    safety: { dryRunOnly: true, submittedActions: false, secretsRedacted: true },
    domSummary,
    operationTrace,
    network: { requests, responses },
    candidateParameters: suggestions.candidateParameters,
    suggestedWorkflow: suggestions.suggestedWorkflow
  };
  writeJson(path.join(runDir, 'learn_report.json'), report);
  await page.screenshot({ path: path.join(runDir, 'page.png'), fullPage: true }).catch(() => null);
  await browser.close();
  return { status: 'learned', runDir, report };
}

async function installTraceHooks(page) {
  await page.addInitScript(() => {
    window.__platformCommandHookInstalled = true;
  });
  await page.evaluate(() => {
    if (window.__platformCommandRuntimeHookInstalled) return;
    window.__platformCommandRuntimeHookInstalled = true;
    const send = (payload) => window.__platformCommandRecord?.(payload);
    document.addEventListener('click', (event) => {
      const el = event.target;
      send({ type: 'click', text: el?.innerText || el?.value || '', selectorHint: el?.id ? `#${el.id}` : el?.getAttribute?.('data-testid') || el?.tagName });
    }, true);
    document.addEventListener('input', (event) => {
      const el = event.target;
      send({ type: 'input', selectorHint: el?.id ? `#${el.id}` : el?.name || el?.tagName, value: '[REDACTED]' });
    }, true);
  });
}

async function summarizeDom(page) {
  return page.evaluate(() => {
    const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120);
    const selector = (el) => ({
      id: el.id || null,
      name: el.getAttribute('name'),
      testId: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label')
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
  const candidateParameters = domSummary.inputs.map((input, index) => ({
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

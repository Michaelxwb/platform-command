import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, ensureDir, maskHeaders, timestamp, writeJson } from './utils.js';

export async function learnAction(options) {
  if (!options.url) throw new Error('learn requires --url');
  const platform = options.platform || 'unknown';
  const action = options.action || 'unknown_action';
  const observeSeconds = Number(options.observeSeconds || 8);
  const runDir = path.join(ROOT, 'runs', `${timestamp()}_${platform}_${action}`);
  ensureDir(runDir);

  const browser = await chromium.launch({ headless: options.headless !== false });
  const page = await browser.newPage();
  const requests = [];
  const responses = [];

  page.on('request', (req) => {
    requests.push({
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      headers: maskHeaders(req.headers()),
      postData: req.postData() ? '[PRESENT]' : null
    });
  });
  page.on('response', async (res) => {
    responses.push({
      url: res.url(),
      status: res.status(),
      contentType: res.headers()['content-type'] || ''
    });
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(Math.max(0, observeSeconds) * 1000);

  const domSummary = await page.evaluate(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
      id: el.id || null,
      placeholder: el.getAttribute('placeholder') || null,
      role: el.getAttribute('role') || null,
      testid: el.getAttribute('data-testid') || el.getAttribute('data-qa') || null
    });
    return {
      title: document.title,
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 120).map(pick),
      buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')).slice(0, 120).map(pick),
      links: Array.from(document.querySelectorAll('a')).slice(0, 120).map(pick),
      forms: Array.from(document.querySelectorAll('form')).slice(0, 20).map((form) => ({
        action: form.getAttribute('action'),
        method: form.getAttribute('method'),
        text: (form.innerText || '').trim().slice(0, 300)
      }))
    };
  });

  const report = {
    platform,
    action,
    url: options.url,
    capturedAt: new Date().toISOString(),
    safety: {
      observationOnly: true,
      submittedActions: false,
      secretsRedacted: true
    },
    domSummary,
    network: { requests, responses }
  };
  writeJson(path.join(runDir, 'learn_report.json'), report);
  await page.screenshot({ path: path.join(runDir, 'page.png'), fullPage: true }).catch(() => null);
  await browser.close();
  return { status: 'learned', runDir, report };
}

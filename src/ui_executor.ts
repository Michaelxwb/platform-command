// @ts-nocheck
import { normalizeRecipe, renderValue } from './workflow.js';
import { resolveOutputPath } from './server_mode.js';

// UI-execution engine (FEAT-014: workflow/legacy UI commands). Drives a
// Playwright page under the user's storageState session. Only reachable on the
// real-run path after the --confirm safety gate; dry-run returns the plan only.
//
// Two command shapes, two action field conventions, normalized here:
//   recipe steps (top-level steps / recipe / execution.workflow):
//     step.ui.actions[] with { type, url, target, selector, value, contains }
//   legacy execution.ui (prefer[0]==='ui'):
//     actions[] with { action, target, selector, value, containsText, when }

export function extractUiActions(command, params) {
  const context = { params, steps: {}, warnings: [] };
  if (isLegacyUiPrimary(command)) {
    return renderValue(command.execution.ui.actions || [], context).map(normalizeAction);
  }
  const steps = recipeUiSteps(command);
  if (steps) {
    const actions = [];
    for (const step of steps) {
      if (step.type === 'ui' || step.ui) actions.push(...(step.ui?.actions || []));
    }
    return renderValue(actions, context).map(normalizeAction);
  }
  return null;
}

export function hasUiExecution(command) {
  return isLegacyUiPrimary(command) || Boolean(recipeUiSteps(command));
}

// Legacy execution.ui counts only when UI is the *primary* path (prefer[0]),
// so api-first commands (prefer:['api','ui']) keep their existing behavior.
function isLegacyUiPrimary(command) {
  return Boolean(command.execution?.ui) && (command.execution?.prefer || [])[0] === 'ui';
}

// Recipe steps (covers top-level steps / recipe / execution.workflow via
// normalizeRecipe) qualify when there is a UI step and no API step — API steps
// route to the api_plan path, not the UI engine.
function recipeUiSteps(command) {
  const steps = normalizeRecipe(command)?.steps;
  if (!Array.isArray(steps)) return null;
  const hasUi = steps.some((step) => step.type === 'ui' || step.ui);
  const hasApi = steps.some((step) => step.type === 'api');
  return hasUi && !hasApi ? steps : null;
}

// Collapse the two field conventions into one shape the runner understands.
function normalizeAction(a) {
  const type = a.action || a.type;
  return {
    type,
    target: a.url || (type === 'goto' ? a.target : undefined),
    selector: a.selector || a.target,
    value: a.value,
    containsText: a.containsText ?? a.contains,
    waitUntil: a.waitUntil,
    fullPage: a.fullPage,
    path: a.path,
    timeoutMs: a.timeoutMs,
    when: a.when
  };
}

const DEFAULT_ACTION_TIMEOUT_MS = Number(process.env.PLATFORM_COMMAND_UI_TIMEOUT_MS || 20000);

// `when` gates an action (e.g. autoPublish on the click). Skip on falsy.
function shouldRun(action) {
  if (!('when' in action) || action.when === undefined) return true;
  const v = action.when;
  return !(v === false || v === 'false' || v === '' || v === null || v === 0 || v === '0');
}

// Execute UI actions on a live page. Returns evidence (per-action outcome +
// screenshot paths) for the acceptance contract; throws on action failure.
export async function executeUiActions(command, params, options = {}) {
  const actions = extractUiActions(command, params);
  if (!actions) throw new Error('No UI actions to execute');
  const { withPlaywrightPage } = await import('./playwright_adapter.js');

  const performed = [];
  const screenshots = [];
  const networkResults = {};
  // Patterns the command wants confirmation from (browser-network-listener:URL).
  // Set up response capture BEFORE any action so the post-submit response is caught.
  const listenPatterns = actions
    .filter((a) => a.type === 'assert' && shouldRun(a) && String(a.selector || '').startsWith('browser-network-listener:'))
    .map((a) => String(a.selector).slice('browser-network-listener:'.length));

  await withPlaywrightPage(async (page) => {
    if (listenPatterns.length) {
      page.on('response', async (resp) => {
        const url = resp.url();
        const pat = listenPatterns.find((p) => url.includes(p));
        if (!pat) return;
        try { networkResults[pat] = await resp.json(); } catch { networkResults[pat] = { _status: resp.status() }; }
      });
    }
    for (const action of actions) {
      if (!shouldRun(action)) { performed.push({ action: action.type, skipped: true, reason: 'when=false' }); continue; }
      await runAction(page, action, { performed, screenshots, networkResults });
    }
    // Wait for the post-submit response(s) the command asked to confirm.
    if (listenPatterns.length) {
      const deadline = Date.now() + 8000;
      while (listenPatterns.some((p) => !networkResults[p]) && Date.now() < deadline) await page.waitForTimeout(300);
    }
  });

  // A captured confirmation response with a non-zero platform code is a real
  // failure (e.g. bilibili reply/add code=12051 "请勿刷屏" duplicate).
  for (const [pat, resp] of Object.entries(networkResults)) {
    if (resp && typeof resp.code === 'number' && resp.code !== 0) {
      throw new Error(`发布未成功: ${pat} 返回 code=${resp.code} ${resp.message || ''}`.trim());
    }
  }

  return {
    status: 'executed',
    command: command.name,
    capability: 'ui_execution',
    adapter: 'playwright',
    actions: performed,
    networkResults,
    screenshots,
    outputPath: screenshots[screenshots.length - 1] || null
  };
}

// Shadow-DOM-piercing locator. Playwright's CSS engine does not reliably pierce
// deeply nested open shadow roots (e.g. bilibili comment web components), so we
// resolve the element in-page via a recursive walk and act on the returned
// handle with Playwright's trusted operations. Supports both `a >>> b` chains
// (each `>>>` crosses one shadow boundary) and plain auto-piercing selectors.
// Passed as a real function (not a string) so Playwright serializes it and
// calls it with the selector arg — a string would be evaluated as a bare
// expression and the arg would be ignored.
function deepQuery(selector) {
  // `tag:has-text("文字")` — querySelector can't match by text, so resolve it
  // with a shadow-piercing text walk (e.g. bilibili publish button has no id/class).
  function pierceText(root, tag, text) {
    const direct = root.querySelectorAll ? root.querySelectorAll(tag || '*') : [];
    for (const el of direct) { if ((el.textContent || '').includes(text)) return el; }
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) { if (el.shadowRoot) { const hit = pierceText(el.shadowRoot, tag, text); if (hit) return hit; } }
    return null;
  }
  function pierce(root, sel) {
    const ht = sel.match(/^(\S*?):has-text\(["']?(.+?)["']?\)$/);
    if (ht) return pierceText(root, ht[1] || '*', ht[2]);
    try { const d = root.querySelector(sel); if (d) return d; } catch (e) { return null; }
    const all = root.querySelectorAll('*');
    for (const el of all) { if (el.shadowRoot) { const hit = pierce(el.shadowRoot, sel); if (hit) return hit; } }
    return null;
  }
  if (selector.includes('>>>')) {
    const parts = selector.split('>>>').map((s) => s.trim());
    let root = document, el = null;
    for (let i = 0; i < parts.length; i++) {
      el = pierce(root, parts[i]);
      if (!el) return null;
      if (i < parts.length - 1) root = el.shadowRoot || el;
    }
    return el;
  }
  return pierce(document, selector);
}

// Resolve a selector to an ElementHandle, polling until present or timeout.
async function resolveHandle(page, selector, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const handle = await page.evaluateHandle(deepQuery, selector);
    const el = handle.asElement();
    if (el) return el;
    await handle.dispose();
    if (Date.now() >= deadline) throw new Error(`定位超时 (${timeout}ms): ${selector}`);
    await page.waitForTimeout(250);
  }
}

async function runAction(page, action, acc) {
  const timeout = Number(action.timeoutMs || DEFAULT_ACTION_TIMEOUT_MS);
  switch (action.type) {
    case 'goto':
      await page.goto(action.target, { waitUntil: action.waitUntil || 'domcontentloaded', timeout });
      break;
    case 'waitFor':
      await resolveHandle(page, action.selector, timeout);
      break;
    case 'scroll': {
      const el = await resolveHandle(page, action.selector, timeout);
      await el.scrollIntoViewIfNeeded().catch(() => el.evaluate((n) => n.scrollIntoView({ block: 'center' })));
      if (action.waitMs) await page.waitForTimeout(Number(action.waitMs));
      break;
    }
    case 'fill': {
      const el = await resolveHandle(page, action.selector, timeout);
      const value = String(action.value ?? '');
      // Framework-driven rich editors (e.g. bilibili contenteditable web
      // components) ignore Playwright fill / JS textContent — their internal
      // model only updates on trusted keyboard input. Focus then type for keys.
      await el.click({ timeout }).catch(() => el.evaluate((n) => n.focus()));
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'input' || tag === 'textarea') {
        await el.fill(value); // fill() already clears existing value
      } else {
        // contenteditable editors (e.g. bilibili) persist drafts — clear any
        // leftover content before typing so the comment is exactly `value`.
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await el.evaluate((n) => { if (n.textContent) { n.textContent = ''; n.dispatchEvent(new InputEvent('input', { bubbles: true })); } });
        await page.keyboard.type(value, { delay: 20 });
      }
      break;
    }
    case 'type': {
      const el = await resolveHandle(page, action.selector, timeout);
      await el.type(String(action.value ?? ''));
      break;
    }
    case 'click': {
      const el = await resolveHandle(page, action.selector, timeout);
      await el.click().catch(() => el.evaluate((n) => n.click()));
      break;
    }
    case 'select': {
      const el = await resolveHandle(page, action.selector, timeout);
      await el.selectOption(action.value);
      break;
    }
    case 'assert': {
      // Pseudo-selector `browser-network-listener:<urlPattern>` marks that the
      // listener (set up in executeUiActions before any action) is active. The
      // response itself is verified AFTER all actions, since this assert is
      // ordered before the click that triggers the request.
      if (String(action.selector || '').startsWith('browser-network-listener:')) {
        acc.performed.push({ action: 'assert', selector: action.selector, listening: true });
        return;
      }
      const el = await resolveHandle(page, action.selector, timeout);
      if (action.containsText) {
        // textContent does not cross shadow boundaries; gather light + shadow text.
        const text = await el.evaluate((n) => {
          function gather(node) {
            let t = '';
            if (node.shadowRoot) t += gather(node.shadowRoot);
            for (const c of node.childNodes || []) {
              if (c.nodeType === 3) t += c.textContent;
              else if (c.nodeType === 1) t += gather(c);
            }
            return t;
          }
          return gather(n);
        });
        if (!String(text).includes(action.containsText)) {
          throw new Error(`assert failed: '${action.selector}' 不含文本 '${action.containsText}'`);
        }
      }
      break;
    }
    case 'screenshot': {
      const out = resolveOutputPath(action.path || `ui-${Date.now()}.png`);
      await page.screenshot({ path: out, fullPage: Boolean(action.fullPage) });
      acc.screenshots.push(out);
      break;
    }
    default:
      throw new Error(`Unsupported UI action: ${action.type}`);
  }
  acc.performed.push({ action: action.type, selector: action.selector, target: action.target });
}

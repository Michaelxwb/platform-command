// @ts-nocheck
const WEBBRIDGE_PORT = Number(process.env.PLATFORM_COMMAND_WEBBRIDGE_PORT || 10086);
const WEBBRIDGE_BASE = `http://127.0.0.1:${WEBBRIDGE_PORT}`;
const WEBBRIDGE_TIMEOUT_MS = 3000;

export async function checkWebbridge() {
  try {
    const r = await fetch(`${WEBBRIDGE_BASE}/status`, { signal: AbortSignal.timeout(WEBBRIDGE_TIMEOUT_MS) });
    if (!r.ok) return { running: false };
    await r.json();
    return { running: true };
  } catch {
    return { running: false };
  }
}

export async function navigateTo(url, groupTitle = '') {
  const args = { url, newTab: true };
  if (groupTitle) args.group_title = groupTitle;
  const r = await fetch(`${WEBBRIDGE_BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'navigate', args }),
    signal: AbortSignal.timeout(15000)
  });
  const result = await r.json();
  if (!result.ok) throw new Error(`webbridge navigate failed: ${result.error || 'unknown'}`);
  return result.data;
}

// Execute a fetch request inside the browser's JS context so httpOnly session
// cookies are attached automatically. Returns parsed JSON body.
export async function fetchViaWebbridge(url, init = {}) {
  const safeInit = {
    method: init.method || 'GET',
    headers: init.headers || {}
  };
  if (init.body !== undefined) safeInit.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);

  const code = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(safeInit)});
    const body = await r.text();
    return JSON.stringify({ status: r.status, ok: r.ok, body });
  })()`;

  const r = await fetch(`${WEBBRIDGE_BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'evaluate', args: { code } }),
    signal: AbortSignal.timeout(Number(init.timeoutMs || 30000) + 5000)
  });
  const result = await r.json();
  if (!result.ok) throw new Error(`webbridge evaluate error: ${result.error || 'unknown'}`);

  const parsed = JSON.parse(result.data.value);
  if (!parsed.ok) {
    const err = new Error(`HTTP ${parsed.status} for ${url}`);
    err.status = parsed.status;
    err.authRequired = [401, 403].includes(parsed.status);
    throw err;
  }
  return JSON.parse(parsed.body);
}

// Extract CSRF token and other session info from the active browser tab.
export async function resolveSessionFromBrowser() {
  const code = `JSON.stringify({
    csrfToken: (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '',
    href: location.href
  })`;
  try {
    const r = await fetch(`${WEBBRIDGE_BASE}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'evaluate', args: { code } }),
      signal: AbortSignal.timeout(5000)
    });
    const result = await r.json();
    if (!result.ok) return {};
    return JSON.parse(result.data.value);
  } catch {
    return {};
  }
}

// Ensure the target domain page is open in the browser. Navigates there if not found.
export async function ensureBrowserSession(targetUrl, options = {}) {
  const wb = await checkWebbridge();
  if (!wb.running) {
    const hint = options.unauthorizedHint ? `\n提示: ${options.unauthorizedHint}` : '';
    throw new Error(`此命令需要已登录的浏览器会话，但 kimi-webbridge 未运行。请先启动浏览器桥接后重试。${hint}`);
  }

  // Navigate to targetUrl if not already on the exact page.
  // Hostname-only matching is insufficient: some platforms (e.g. aTrust/sangfor)
  // refresh session state only when the user navigates to the specific app path.
  let currentHref = '';
  try {
    const probe = await fetch(`${WEBBRIDGE_BASE}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'evaluate', args: { code: 'JSON.stringify({href:location.href})' } }),
      signal: AbortSignal.timeout(3000)
    });
    const probeResult = await probe.json();
    if (probeResult.ok) {
      currentHref = JSON.parse(probeResult.data.value).href || '';
    }
  } catch { /* ignore */ }

  const target = new URL(targetUrl);
  const current = currentHref ? (() => { try { return new URL(currentHref); } catch { return null; } })() : null;
  // For SPAs, pathname is constant; the hash fragment identifies the actual page.
  const onTargetPage = current &&
    current.hostname === target.hostname &&
    current.pathname === target.pathname &&
    current.hash === target.hash;

  if (!onTargetPage) {
    await navigateTo(targetUrl, target.hostname);
    // Wait for page to load and session to initialize
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// @ts-nocheck
// Infer what execution capabilities a command needs so callers (schedule /
// doctor / capabilities) can decide which adapter to use.
//
// Priority: command.requires (explicit) > runtime.auth.type > heuristics
//
//   http    - plain HTTP with Node fetch (public APIs, bearer token from env)
//   session - needs a logged-in browser session (httpOnly cookie / CSRF /
//             zero-trust). NOT the same as a bearer token.
//   ui      - needs real DOM interaction (click/fill/shadow DOM)
export function inferRequirements(command = {}) {
  const base = { http: false, session: false, ui: false };

  // Explicit declaration wins.
  if (command.requires && typeof command.requires === 'object' && !Array.isArray(command.requires)) {
    return { ...base, ...command.requires };
  }

  // runtime.auth.type is the preferred explicit field for auth dependency.
  const authType = command.runtime?.auth?.type || '';
  if (authType === 'browser_session_cookie') base.session = true;
  if (authType === 'bearer_token' || authType === 'api_key') base.http = true;

  // Heuristic fallbacks.
  if (command.dataSource?.type === 'http_json' || command.execution?.api) base.http = true;

  if (!base.session) {
    const sessionRef = String(command.sessionRef || '');
    if (/browser|prelogged|webbridge|playwright|atrust|cookie-session/i.test(sessionRef)) base.session = true;
    if (/\{\{\s*session\./i.test(safeStringify(command))) base.session = true;
  }

  const steps = collectSteps(command);
  if (steps.some((step) => step.type === 'ui' || step.ui)) base.ui = true;
  if (command.execution?.ui || (Array.isArray(command.execution?.prefer) && command.execution.prefer.includes('ui'))) base.ui = true;

  return base;
}

// True when the command can only run with a logged-in browser present
// (interactive session or UI interaction) — i.e. not safe for unattended runs.
export function requiresBrowser(command) {
  const r = inferRequirements(command);
  return !!(r.session || r.ui);
}

function collectSteps(command) {
  if (Array.isArray(command.steps)) return command.steps;
  if (Array.isArray(command.execution?.workflow?.steps)) return command.execution.workflow.steps;
  return [];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

// Infer what execution capabilities a command needs so callers (schedule /
// doctor) can decide whether a host can actually run it unattended.
// Explicit `command.requires` wins; otherwise fall back to heuristics.
//
//   http    - plain HTTP, Node can run it (public read APIs)
//   session - needs an interactive logged-in browser session (httpOnly cookie /
//             CSRF / zero-trust). NOT the same as a bearer token from env.
//   ui      - needs real page interaction (click/fill/shadow DOM)
export function inferRequirements(command = {}) {
  const base = { http: false, session: false, ui: false };
  if (command.requires && typeof command.requires === 'object' && !Array.isArray(command.requires)) {
    return { ...base, ...command.requires };
  }
  if (command.dataSource?.type === 'http_json' || command.execution?.api) base.http = true;

  const sessionRef = String(command.sessionRef || '');
  if (/browser|prelogged|webbridge|playwright|atrust|cookie-session/i.test(sessionRef)) base.session = true;
  if (/\{\{\s*session\./i.test(safeStringify(command))) base.session = true;

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

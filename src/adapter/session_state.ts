// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataBaseDir } from '../entry/server_mode.js';

// Per-host session health markers (FEAT-05). One JSON per host; local mode
// under cwd, server mode pinned to the user's data volume (DATA_DIR).
function sessionsDir() {
  return path.join(resolveDataBaseDir(), '.platform-command', 'sessions');
}

function sessionFile(host) {
  const safe = String(host || '').toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  if (!safe) throw new Error('session host is required');
  return path.join(sessionsDir(), `${safe}.json`);
}

// Atomic write (temp + rename) so a concurrent reader never sees half a file.
export function markSessionInvalid(host, reason = '') {
  const file = sessionFile(host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ host, invalid: true, reason, at: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

export function clearSessionInvalid(host) {
  fs.rmSync(sessionFile(host), { force: true });
}

export function getSessionState(host) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(host), 'utf8'));
    return { invalid: Boolean(parsed.invalid), reason: parsed.reason || '', at: parsed.at || '' };
  } catch {
    return { invalid: false, reason: '', at: '' };
  }
}

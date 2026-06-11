// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { redactSensitive } from './utils.js';
import { resolveDataBaseDir, serverModeMeta } from './server_mode.js';

// Run records belong to the consuming project, not the package install dir
// (which may be read-only under a global install). Local mode resolves under
// cwd at call time; server mode pins to PLATFORM_COMMAND_DATA_DIR.
function runsDir() {
  return path.join(resolveDataBaseDir(), '.platform-command', 'runs');
}

export function recordRun(run) {
  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = run.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const file = path.join(dir, `${id}.json`);
  // serverModeMeta() adds userId only in server mode; local records keep the old shape.
  const payload = redactSensitive({ id, createdAt: new Date().toISOString(), ...serverModeMeta(), ...run });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return { ...payload, file };
}

export function listRuns(options = {}) {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .slice(-(Number(options.limit) || 20))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

export function summarizeRuns(options = {}) {
  const runs = listRuns(options);
  const byStatus = {};
  for (const run of runs) byStatus[run.status || 'unknown'] = (byStatus[run.status || 'unknown'] || 0) + 1;
  return { total: runs.length, byStatus, runs };
}

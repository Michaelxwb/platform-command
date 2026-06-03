import fs from 'node:fs';
import path from 'node:path';
import { ROOT, redactSensitive } from './utils.js';

const RUNS_DIR = path.join(ROOT, '.platform-command', 'runs');

export function recordRun(run) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const id = run.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = redactSensitive({ id, createdAt: new Date().toISOString(), ...run });
  fs.writeFileSync(path.join(RUNS_DIR, `${id}.json`), JSON.stringify(payload, null, 2));
  return payload;
}

export function listRuns(options = {}) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .slice(-(Number(options.limit) || 20))
    .map((name) => JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name), 'utf8')));
}

export function summarizeRuns(options = {}) {
  const runs = listRuns(options);
  const byStatus = {};
  for (const run of runs) byStatus[run.status || 'unknown'] = (byStatus[run.status || 'unknown'] || 0) + 1;
  return { total: runs.length, byStatus, runs };
}

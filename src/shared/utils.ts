// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function findPackageRoot(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'commands'))) return dir;
    dir = path.dirname(dir);
  }
  return MODULE_ROOT;
}

export const ROOT = findPackageRoot(MODULE_ROOT);

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function shortId(input = '') {
  return crypto.createHash('sha1').update(String(input) + Date.now()).digest('hex').slice(0, 8);
}

export function parseKeyValues(items = []) {
  const out = {};
  for (const item of items) {
    const idx = item.indexOf('=');
    if (idx <= 0) throw new Error(`Invalid parameter '${item}', expected key=value`);
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

export function maskHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|cookie|token|secret|key/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/authorization|cookie|password|passwd|token|secret|private[_-]?key|api[_-]?key/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactSensitive(item);
      }
    }
    return out;
  }
  if (typeof value === 'string' && /^(Bearer\s+|eyJ[a-zA-Z0-9_-]+\.|[A-Za-z0-9+/=]{40,})/.test(value)) return '[REDACTED]';
  return value;
}

export function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

// 并发执行：最多 maxWorkers 个 task 同时运行，其余排队（完成一个领下一个），
// 返回与输入等长、按序的结果数组 [{ok:true,value}|{ok:false,error}]。错误不中断其它 task。
export async function runWithConcurrency(taskFns, maxWorkers = 3) {
  const results = new Array(taskFns.length);
  let next = 0;
  const worker = async () => {
    while (next < taskFns.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await taskFns[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err.message };
      }
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(maxWorkers, taskFns.length || 1)) }, worker);
  await Promise.all(pool);
  return results;
}

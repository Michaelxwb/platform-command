import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

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

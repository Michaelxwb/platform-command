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

export function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

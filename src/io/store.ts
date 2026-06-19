// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommandResource } from '../model/command_store.js';

// 平台 store 层（FEAT-01）：每个平台命令包下 `commands/<platform>/store/<key>.json`
// 持久化业务状态。平台无关——任何命令包都可有自己的 store/ 目录。
// 路径解析复用 resolveCommandResource 的越界防护：store 文件必须落在命令包目录内。

const STORE_DIR = 'store';

// key 只允许文件名安全字符，杜绝 `..`/`/` 等路径穿越；非法直接抛错而非静默清洗，
// 避免「清洗后误命中另一个 key」。
function assertKey(key) {
  const text = String(key);
  if (!text || /[^a-zA-Z0-9_.-]/.test(text) || text === '.' || text === '..') {
    throw new Error(`Invalid store key: ${key}`);
  }
  return text;
}

function storeFile(commandDir, key) {
  return resolveCommandResource(commandDir, path.join(STORE_DIR, `${assertKey(key)}.json`));
}

// 读取一个 store 条目；不存在返回 null（调用方据此走自动初始化）。
export function readStore(commandDir, key) {
  const file = storeFile(commandDir, key);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 浅合并写入（patch 覆盖同名顶层字段），原子落盘（临时文件 + rename）避免并发写损坏。
export function writeStore(commandDir, key, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('writeStore patch must be a plain object');
  }
  const file = storeFile(commandDir, key);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

// 整体替换写入（不合并），用于「初始化默认配置」等需要确定性内容的场景。
export function replaceStore(commandDir, key, value = {}) {
  const file = storeFile(commandDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

// 列出该平台 store 下所有 key（不含 .json 后缀），无目录返回空数组。
export function listStore(commandDir) {
  const dir = resolveCommandResource(commandDir, STORE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
}

// 删除一个 store 条目；不存在视为已删除返回 false。
export function deleteStore(commandDir, key) {
  const file = storeFile(commandDir, key);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

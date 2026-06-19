// @ts-nocheck
import { pathToFileURL } from 'node:url';
import { renderValue } from './workflow.js';
import { resolveCommandResource } from '../model/command_store.js';
import { readStore, writeStore, replaceStore, deleteStore } from '../io/store.js';

// store 命令引擎（FEAT-06 支撑）：让命令直接读写平台 store 层。
// 命令声明：
//   store: {
//     op: "read" | "merge" | "init" | "delete",
//     key: "{{params.companyId}}",          // templated store key
//     patch: "{{params.config}}",           // merge 用：要合并的对象（来自参数）
//     defaults: { ... }                      // read/merge/init 时缺失则用它自动初始化
//   }
// 平台无关——任何平台命令都能用自己的 store/ 目录做持久化 CRUD。

export function hasStoreOp(command) {
  return Boolean(command?.store && typeof command.store.op === 'string');
}

// 读结果的可选派生：command.store.derive 指向 command-local JS，对读到的 config 计算附加字段
// （如 autoSend/autoSync = flag && !report_check），并入返回 meta。
async function applyDerive(config, deriveSpec, commandDir, params) {
  if (!deriveSpec) return config;
  const spec = typeof deriveSpec === 'string' ? { module: deriveSpec, export: 'derive' } : deriveSpec;
  const moduleUrl = pathToFileURL(resolveCommandResource(commandDir, spec.module));
  if (process.env.PLATFORM_COMMAND_RELOAD_SIGNER === '1') moduleUrl.searchParams.set('t', String(Date.now()));
  const imported = await import(moduleUrl.href);
  const fn = imported[spec.export || 'derive'];
  if (typeof fn !== 'function') throw new Error(`store.derive export not found: ${spec.export || 'derive'} in ${spec.module}`);
  return { ...config, ...(fn(config, { params }) || {}) };
}

export async function executeStoreCommand(command, params = {}, options = {}) {
  const commandDir = options.commandDir;
  if (!commandDir) throw new Error('store command requires commandDir');
  const ctx = { params, steps: {} };
  const spec = command.store;
  const op = spec.op;
  const key = renderValue(spec.key, ctx);
  if (!key && key !== 0) throw new Error('store.key is required (resolved empty)');
  const defaults = spec.defaults !== undefined ? renderValue(spec.defaults, ctx) : null;

  const result = (capability, meta) => ({
    status: 'executed',
    command: command.name,
    capability,
    key: String(key),
    rows: [],
    meta: meta || {}
  });

  if (op === 'read') {
    let cfg = readStore(commandDir, key);
    let initialized = false;
    if (cfg === null && defaults !== null) {
      cfg = replaceStore(commandDir, key, defaults);
      initialized = true;
    }
    const derived = await applyDerive(cfg || {}, spec.derive, commandDir, params);
    return result('store_read', { ...derived, _initialized: initialized });
  }

  if (op === 'init') {
    let cfg = readStore(commandDir, key);
    let initialized = false;
    if (cfg === null) {
      cfg = replaceStore(commandDir, key, defaults || {});
      initialized = true;
    }
    return result('store_init', { ...(cfg || {}), _initialized: initialized });
  }

  if (op === 'merge') {
    // 缺失先按 defaults 初始化，再合并补丁，保证 daemon/导出下游开关始终有完整字段。
    if (readStore(commandDir, key) === null && defaults !== null) {
      replaceStore(commandDir, key, defaults);
    }
    const patch = spec.patch !== undefined ? renderValue(spec.patch, ctx) : {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('store.patch must resolve to a plain object');
    }
    const merged = writeStore(commandDir, key, patch);
    return result('store_merge', merged);
  }

  if (op === 'delete') {
    const removed = deleteStore(commandDir, key);
    return result('store_delete', { removed });
  }

  throw new Error(`Unsupported store.op: ${op}`);
}

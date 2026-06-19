// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

// Server mode (multi-user container deployment) is opt-in via explicit env
// vars. With none of them set, every accessor reports "disabled" and callers
// must preserve the exact local single-user behavior (never break userspace).
const ENV_USER_ID = 'PLATFORM_COMMAND_USER_ID';
const ENV_STORAGE_STATE = 'PLATFORM_COMMAND_STORAGE_STATE';
const ENV_OUTPUT_DIR = 'PLATFORM_COMMAND_OUTPUT_DIR';
const ENV_DATA_DIR = 'PLATFORM_COMMAND_DATA_DIR';

export function resolveServerMode() {
  const userId = (process.env[ENV_USER_ID] || '').trim();
  const storageStatePath = (process.env[ENV_STORAGE_STATE] || '').trim();
  const outputDir = (process.env[ENV_OUTPUT_DIR] || '').trim();
  const dataDir = (process.env[ENV_DATA_DIR] || '').trim();
  if (!userId && !storageStatePath && !outputDir && !dataDir) {
    return { enabled: false, userId: null, storageStatePath: null, outputDir: null, dataDir: null };
  }
  if (!userId) {
    const provided = [storageStatePath && ENV_STORAGE_STATE, outputDir && ENV_OUTPUT_DIR, dataDir && ENV_DATA_DIR].filter(Boolean).join(', ');
    throw new Error(`服务器模式配置不完整：已设置 ${provided}，但缺少 ${ENV_USER_ID}。请补全配置，或清除全部服务器模式环境变量以回到本地模式。`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(userId)) {
    throw new Error(`${ENV_USER_ID} 格式无效: '${userId}'（仅允许字母数字与 . _ - ，且以字母数字开头）`);
  }
  return {
    enabled: true,
    userId,
    storageStatePath: storageStatePath ? path.resolve(storageStatePath) : null,
    outputDir: outputDir ? path.resolve(outputDir) : null,
    dataDir: dataDir ? path.resolve(dataDir) : null
  };
}

// Base directory for run records and session-health markers. Server mode pins
// it to the user's data volume so records survive container rebuilds and do
// not scatter across subprocess cwds; local mode keeps the historical cwd.
export function resolveDataBaseDir() {
  try {
    const mode = resolveServerMode();
    if (mode.enabled && mode.dataDir) return mode.dataDir;
  } catch { /* 配置错误由 adapter/readiness 路径显式上报，这里保守回退 cwd */ }
  return process.cwd();
}

export function isServerMode() {
  return resolveServerMode().enabled;
}

// Additive metadata for run records. Never throws: a broken server-mode config
// is surfaced loudly by the adapter/readiness paths; metadata enrichment must
// not turn record writes into a second crash site.
export function serverModeMeta() {
  try {
    const mode = resolveServerMode();
    return mode.enabled ? { userId: mode.userId } : {};
  } catch {
    return {};
  }
}

// Resolve symlinks on the deepest existing ancestor so sandbox checks cannot
// be escaped through links or not-yet-created paths.
function realpathDeepest(target) {
  let dir = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

// Output sandbox (FN-04). Local mode: identical to the historical
// path.resolve() behavior. Server mode with OUTPUT_DIR: relative paths land
// inside the sandbox, absolute paths must stay inside it.
export function resolveOutputPath(requested) {
  if (!requested) throw new Error('output path is required');
  const mode = resolveServerMode();
  if (!mode.enabled || !mode.outputDir) return path.resolve(requested);
  const root = realpathDeepest(mode.outputDir);
  const target = path.isAbsolute(requested) ? requested : path.join(root, requested);
  const real = realpathDeepest(target);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`输出路径越界: ${requested}。服务器模式下输出必须位于 ${root} 内（由 ${ENV_OUTPUT_DIR} 限定）。`);
  }
  return real;
}

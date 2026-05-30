import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from './utils.js';

export const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

export function builtinCommandsDir() {
  return path.join(ROOT, 'commands');
}

export function externalCommandsDirs(options = {}) {
  const dirs = [];
  const explicit = options.commandsDir || process.env.PLATFORM_COMMANDS_DIR;
  if (explicit) dirs.push(...String(explicit).split(path.delimiter));
  const cwdCommands = path.join(process.cwd(), 'commands');
  if (cwdCommands !== builtinCommandsDir()) dirs.push(cwdCommands);
  return dirs.filter(Boolean).map((dir) => path.resolve(dir));
}

export function commandSearchDirs(options = {}) {
  const seen = new Set();
  const dirs = [...externalCommandsDirs(options), builtinCommandsDir()];
  return dirs.filter((dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

export function assertCommandName(commandName) {
  const safe = String(commandName || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe || safe !== commandName) throw new Error(`Invalid command name: ${commandName}`);
  return safe;
}

export function commandPath(commandName, options = {}) {
  const safe = assertCommandName(commandName);
  const platformCommand = splitPlatformCommand(safe);
  for (const dir of commandSearchDirs(options)) {
    const file = path.join(dir, `${safe}.json`);
    if (fs.existsSync(file)) return file;
    const packageFile = path.join(dir, safe, 'command.json');
    if (fs.existsSync(packageFile)) return packageFile;
    if (platformCommand) {
      const platformFile = path.join(dir, platformCommand.platform, 'cmd', `${platformCommand.action}.json`);
      if (fs.existsSync(platformFile)) return platformFile;
      const platformPackageFile = path.join(dir, platformCommand.platform, 'cmd', platformCommand.action, 'command.json');
      if (fs.existsSync(platformPackageFile)) return platformPackageFile;
    }
  }
  return path.join(builtinCommandsDir(), `${safe}.json`);
}

export function loadCommand(commandName, options = {}) {
  const file = commandPath(commandName, options);
  if (!fs.existsSync(file)) throw new Error(`Command not found: ${commandName} (searched: ${commandSearchDirs(options).join(', ')})`);
  return { file, source: sourceForFile(file), command: hydrateCommand(readJson(file), file) };
}

export function listCommands(options = {}) {
  const found = new Map();
  for (const dir of commandSearchDirs(options)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(entry);
      } catch {
        continue; // skip broken symlinks / unreadable entries
      }
      let command = '';
      let file = '';
      if (stat.isFile() && name.endsWith('.json')) {
        command = name.replace(/\.json$/, '');
        file = entry;
      } else if (stat.isDirectory() && fs.existsSync(path.join(entry, 'command.json'))) {
        command = name;
        file = path.join(entry, 'command.json');
      } else if (stat.isDirectory() && fs.existsSync(path.join(entry, 'cmd'))) {
        for (const item of listPlatformCommandFiles(entry)) {
          const loaded = readJson(item.file);
          command = loaded.name || `${name}.${item.action}`;
          file = item.file;
          if (!found.has(command)) {
            found.set(command, options.detailed ? commandMetadata(command, file) : command);
          }
        }
        continue;
      } else {
        continue;
      }
      if (!found.has(command)) {
        found.set(command, options.detailed ? commandMetadata(command, file) : command);
      }
    }
  }
  return Array.from(found.values()).sort((a, b) => String(a.name || a).localeCompare(String(b.name || b)));
}

function hydrateCommand(command, file) {
  const commandDir = commandResourceRoot(file);
  const hydrated = structuredClone(command);
  if (hydrated.output?.columnsTemplate && !hydrated.output.columns) {
    hydrated.output.columns = readCommandResourceJson(commandDir, hydrated.output.columnsTemplate);
  }
  return hydrated;
}

export function commandResourceRoot(file) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  if (path.basename(parent) === 'cmd') return path.dirname(parent);
  if (path.basename(resolved) === 'command.json' && path.basename(path.dirname(parent)) === 'cmd') return path.dirname(path.dirname(parent));
  return parent;
}

function splitPlatformCommand(commandName) {
  const index = commandName.indexOf('.');
  if (index < 1 || index === commandName.length - 1) return null;
  return { platform: commandName.slice(0, index), action: commandName.slice(index + 1) };
}

function listPlatformCommandFiles(platformDir) {
  const cmdDir = path.join(platformDir, 'cmd');
  if (!fs.existsSync(cmdDir)) return [];
  const files = [];
  for (const name of fs.readdirSync(cmdDir)) {
    const entry = path.join(cmdDir, name);
    const stat = fs.statSync(entry);
    if (stat.isFile() && name.endsWith('.json')) {
      files.push({ action: name.replace(/\.json$/, ''), file: entry });
    } else if (stat.isDirectory() && fs.existsSync(path.join(entry, 'command.json'))) {
      files.push({ action: name, file: path.join(entry, 'command.json') });
    }
  }
  return files;
}

function readCommandResourceJson(commandDir, resourcePath) {
  const resolved = resolveCommandResource(commandDir, resourcePath);
  return readJson(resolved);
}

export function resolveCommandResource(commandDir, resourcePath) {
  if (!resourcePath || typeof resourcePath !== 'string') throw new Error('resourcePath must be a string');
  const resolved = path.resolve(commandDir, resourcePath);
  const root = path.resolve(commandDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Command resource escapes command directory: ${resourcePath}`);
  }
  return resolved;
}

function sourceForFile(file) {
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(builtinCommandsDir()) + path.sep) ? 'builtin' : 'external';
}

export function commandMetadata(commandName, file) {
  const resolved = path.resolve(file);
  const source = sourceForFile(resolved);
  const packageRoot = findCommandPackageRoot(resolved);
  const pkg = readPackageMetadata(packageRoot);
  return {
    name: commandName,
    file: resolved,
    source,
    package: {
      name: pkg.name || (source === 'builtin' ? 'platform-command-builtin' : path.basename(packageRoot)),
      version: pkg.version || null,
      root: packageRoot,
      type: source === 'builtin' ? 'builtin' : 'external',
      description: pkg.description || null
    }
  };
}

function findCommandPackageRoot(file) {
  let dir = path.dirname(path.resolve(file));
  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'commands'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(file));
}

function readPackageMetadata(packageRoot) {
  const packageFile = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageFile)) return {};
  try {
    const pkg = readJson(packageFile);
    return { name: pkg.name, version: pkg.version, description: pkg.description };
  } catch {
    return {};
  }
}

export function mergeParams(command, provided = {}) {
  const merged = {};
  const params = command.parameters || {};
  for (const [name, spec] of Object.entries(params)) {
    if (Object.prototype.hasOwnProperty.call(provided, name)) {
      merged[name] = coerceParam(name, provided[name], spec);
    } else if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
      merged[name] = coerceParam(name, spec.default, spec);
    } else if (spec.required) {
      throw new Error(`Missing required parameter: ${name}`);
    }
  }
  for (const [name, value] of Object.entries(provided)) {
    if (!Object.prototype.hasOwnProperty.call(merged, name)) merged[name] = value;
  }
  return merged;
}

export function coerceParam(name, value, spec = {}) {
  const type = spec.type || 'string';
  if (!PARAM_TYPES.has(type)) throw new Error(`Unsupported parameter type for ${name}: ${type}`);
  let coerced = value;
  if (type === 'string') {
    coerced = value == null ? '' : String(value);
  } else if (type === 'number') {
    if (typeof value === 'number') coerced = value;
    else if (typeof value === 'string' && value.trim() !== '') coerced = Number(value);
    if (typeof coerced !== 'number' || Number.isNaN(coerced)) throw new Error(`Parameter ${name} must be a number`);
  } else if (type === 'boolean') {
    if (typeof value === 'boolean') coerced = value;
    else if (typeof value === 'string' && /^(true|1|yes)$/i.test(value)) coerced = true;
    else if (typeof value === 'string' && /^(false|0|no)$/i.test(value)) coerced = false;
    else throw new Error(`Parameter ${name} must be a boolean`);
  } else if (type === 'array') {
    if (Array.isArray(value)) coerced = value;
    else if (typeof value === 'string') {
      try { coerced = JSON.parse(value); } catch { coerced = value.split(',').map((item) => item.trim()).filter(Boolean); }
    }
    if (!Array.isArray(coerced)) throw new Error(`Parameter ${name} must be an array`);
  } else if (type === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) coerced = value;
    else if (typeof value === 'string') {
      try { coerced = JSON.parse(value); } catch { throw new Error(`Parameter ${name} must be a JSON object`); }
    }
    if (!coerced || typeof coerced !== 'object' || Array.isArray(coerced)) throw new Error(`Parameter ${name} must be an object`);
  }
  if (spec.enum) {
    if (type === 'array' || type === 'object') throw new Error(`Parameter ${name}: enum is only supported for scalar types`);
    if (!spec.enum.includes(coerced)) throw new Error(`Parameter ${name} must be one of: ${spec.enum.join(', ')}`);
  }
  return coerced;
}

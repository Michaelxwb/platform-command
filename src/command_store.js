import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from './utils.js';

export const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

export function commandPath(commandName) {
  const safe = commandName.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe || safe !== commandName) throw new Error(`Invalid command name: ${commandName}`);
  return path.join(ROOT, 'commands', `${safe}.json`);
}

export function loadCommand(commandName) {
  const file = commandPath(commandName);
  if (!fs.existsSync(file)) throw new Error(`Command not found: ${commandName} (${file})`);
  return { file, command: readJson(file) };
}

export function listCommands() {
  const dir = path.join(ROOT, 'commands');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
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
  if (spec.enum && !spec.enum.includes(coerced)) throw new Error(`Parameter ${name} must be one of: ${spec.enum.join(', ')}`);
  return coerced;
}

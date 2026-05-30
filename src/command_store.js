import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from './utils.js';

export function commandPath(commandName) {
  const safe = commandName.replace(/[^a-zA-Z0-9_.-]/g, '');
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
      merged[name] = provided[name];
    } else if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
      merged[name] = spec.default;
    } else if (spec.required) {
      throw new Error(`Missing required parameter: ${name}`);
    }
  }
  for (const [name, value] of Object.entries(provided)) {
    if (!Object.prototype.hasOwnProperty.call(merged, name)) merged[name] = value;
  }
  return merged;
}

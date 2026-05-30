import { loadCommand } from './command_store.js';

const REQUIRED_TOP_LEVEL = ['name', 'platform', 'description', 'riskLevel', 'parameters', 'execution', 'successCriteria'];

export function verifyCommand(commandName) {
  const { file, command } = loadCommand(commandName);
  const errors = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!Object.prototype.hasOwnProperty.call(command, key)) errors.push(`Missing top-level field: ${key}`);
  }
  if (command.name && command.name !== commandName) {
    errors.push(`Command name mismatch: file requested '${commandName}', command.name '${command.name}'`);
  }
  if (command.riskLevel && !['low', 'medium', 'high'].includes(command.riskLevel)) {
    errors.push('riskLevel must be one of: low, medium, high');
  }
  if (typeof command.parameters !== 'object' || Array.isArray(command.parameters)) {
    errors.push('parameters must be an object');
  } else {
    for (const [name, spec] of Object.entries(command.parameters)) {
      if (!spec.type) errors.push(`Parameter '${name}' missing type`);
      if (spec.enum && !Array.isArray(spec.enum)) errors.push(`Parameter '${name}' enum must be an array`);
    }
  }
  if (!command.execution || !Array.isArray(command.execution.prefer)) {
    errors.push('execution.prefer must be an array, e.g. ["api", "ui"]');
  }
  if (!Array.isArray(command.successCriteria) || command.successCriteria.length === 0) {
    errors.push('successCriteria must be a non-empty array');
  }
  return { ok: errors.length === 0, file, errors, command };
}

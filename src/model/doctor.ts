// @ts-nocheck
import fs from 'node:fs';
import { listCommands, loadCommand } from './command_store.js';
import { verifyCommand } from './verify.js';
import { describeCommand } from './describe.js';

export function doctorCommand(commandName, options = {}) {
  const startedAt = new Date().toISOString();
  const checks = [];
  const push = (name, ok, details = {}) => checks.push({ name, ok: !!ok, ...details });
  try {
    const verify = verifyCommand(commandName, { commandsDir: options.commandsDir });
    push('schema.verify', verify.ok, { errors: verify.errors || [], file: verify.file });
    const desc = describeCommand(commandName, options);
    push('command.load', true, { file: desc.file, source: desc.metadata?.source });
    push('parameters.required', !desc.missingRequired?.length, { missingRequired: desc.missingRequired || [] });
    push('execution.capability', !!(desc.capability?.recommended || desc.capability?.executable), { capability: desc.capability });
    push('safety.riskLevel', !!desc.riskLevel && desc.riskLevel !== 'unknown', { riskLevel: desc.riskLevel });
    push('auth.declared', !!desc.auth || desc.riskLevel === 'low', { auth: desc.auth || null });
    push('nl.declared', !!desc.naturalLanguage, { naturalLanguage: !!desc.naturalLanguage });
    return finish(startedAt, commandName, checks);
  } catch (error) {
    push('doctor.exception', false, { error: error.message });
    return finish(startedAt, commandName, checks);
  }
}

export function doctorAll(options = {}) {
  const commands = listCommands({ detailed: true, commandsDir: options.commandsDir });
  const results = commands.map((item) => doctorCommand(item.name, options));
  return { ok: results.every((item) => item.ok), total: results.length, results };
}

export function environmentDoctor() {
  return {
    node: process.version,
    cwd: process.cwd(),
    platform: process.platform,
    env: {
      PLATFORM_COMMANDS_DIR: process.env.PLATFORM_COMMANDS_DIR || null
    }
  };
}

function finish(startedAt, command, checks) {
  return {
    command,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: checks.every((item) => item.ok),
    checks
  };
}

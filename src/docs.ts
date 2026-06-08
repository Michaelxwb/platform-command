// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { listCommands, loadCommand } from './command_store.js';
import { getExecutionCapability } from './execute.js';

export function generateCommandDocs({ commandsDir, outputPath } = {}) {
  const commands = listCommands({ detailed: true, commandsDir });
  const lines = ['# platform-command command catalog', ''];
  for (const item of commands) {
    const { command } = loadCommand(item.name, { commandsDir });
    const capability = getExecutionCapability(command);
    lines.push(`## ${item.name}`, '');
    if (command.description) lines.push(command.description, '');
    lines.push(`- source: ${item.source || 'unknown'}`);
    lines.push(`- riskLevel: ${command.riskLevel || 'unknown'}`);
    lines.push(`- executable: ${capability.executable}`);
    if (capability.engine) lines.push(`- engine: ${capability.engine}`);
    const paramEntries = Object.entries(command.parameters || {});
    if (paramEntries.length) {
      lines.push('', '### Parameters', '');
      for (const [name, spec] of paramEntries) {
        lines.push(`- ${name}${spec.required ? ' (required)' : ''}: ${spec.description || spec.type || ''}`);
      }
    }
    lines.push('');
  }
  const markdown = lines.join('\n');
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown);
  }
  return { outputPath, commands: commands.length, markdown };
}

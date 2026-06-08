#!/usr/bin/env node
// @ts-nocheck
import { listCommands } from './command_store.js';
import { executeCommand } from './execute.js';
import { learnAction } from './learn.js';
import { formatHumanReadable, runNaturalLanguage } from './nl.js';
import { buildAgentManifest, describeCommand, explainNaturalLanguage } from './describe.js';
import { doctorAll, doctorCommand, environmentDoctor } from './doctor.js';
import { initCommandScaffold } from './init.js';
import { listRuns, summarizeRuns } from './runs.js';
import {
  buildScheduleSpec,
  formatScheduleMarkdown,
  getScheduleStatus,
  installSchedule,
  listSchedules,
  removeSchedule
} from './schedule.js';
import { generateCommandDocs } from './docs.js';
import { parseKeyValues, printJson } from './utils.js';
import { verifyCommand } from './verify.js';
import { runMcpServer } from './mcp_server.js';

function help() {
  console.log(`platform-command

Usage:
  platform-command --help
  platform-command list [--json] [--commands-dir <dir>]
  platform-command describe <name> [--json] [key=value ...]
  platform-command explain "自然语言指令" [--json]
  platform-command agent --json
  platform-command doctor [--command <name>] [--json]
  platform-command runs [--summary] [--limit 20]
  platform-command schedule plan --command <name> --cron <expr> [--json] key=value ...
  platform-command schedule install --command <name> --cron <expr> [--dry-run|--confirm] [--dry-run-command] [--json] key=value ...
  platform-command schedule list [--json]
  platform-command schedule status --id <id> [--json]
  platform-command schedule remove --id <id> [--dry-run|--confirm] [--json]
  platform-command docs [--output <path>] [--commands-dir <dir>]
  platform-command init --platform <name> --action <name> [--dir commands]
  platform-command mcp
  platform-command verify <name> [--commands-dir <dir>]
  platform-command verify --command <name> [--commands-dir <dir>]
  platform-command execute --command <name> [--commands-dir <dir>] [--dry-run] key=value ...
  platform-command ask "自然语言指令" [--json] [--execute-real --confirm]
  platform-command execute --command <name> --execute-real --confirm key=value ...
  platform-command learn --platform <name> --action <name> --url <url> [--observe-seconds 8] [--headed]

Examples:
  platform-command verify demo.search_example
  platform-command execute --command demo.search_example --dry-run keyword=abc
  platform-command ask "在 GitHub 上，查看 zhaoxuya520/reverse-skill 的 issues，状态 all"
  platform-command execute --command demo.workflow_example --dry-run keyword=abc limit=5
  platform-command execute --command demo.workflow_example --execute-real --confirm keyword=abc limit=5
  platform-command learn --platform demo --action inspect --url https://example.com --observe-seconds 3
  platform-command mcp
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (['dryRun', 'dryRunCommand', 'confirm', 'headed', 'executeReal', 'json', 'summary', 'force'].includes(key)) out[key] = true;
      else out[key] = argv[++i];
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function extractExecuteParams(args) {
  const params = parseKeyValues(args._);
  const reserved = new Set(['_', 'command', 'commandsDir', 'dryRun', 'confirm', 'headed', 'executeReal', 'json', 'cron', 'timezone', 'output']);
  for (const [key, value] of Object.entries(args)) {
    if (!reserved.has(key)) params[key] = value;
  }
  return params;
}

function extractScheduleParams(args, subcmd = 'plan') {
  const positional = args._[0] === subcmd ? args._.slice(1) : args._;
  const params = parseKeyValues(positional);
  const reserved = new Set([
    '_',
    'id',
    'command',
    'commandsDir',
    'cron',
    'timezone',
    'dryRun',
    'dryRunCommand',
    'confirm',
    'executeReal',
    'json',
    'output',
    'headed'
  ]);
  for (const [key, value] of Object.entries(args)) {
    if (!reserved.has(key)) params[key] = value;
  }
  return params;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!cmd || cmd === '--help' || cmd === 'help') return help();
  if (cmd === 'list') {
    const commands = listCommands({ detailed: !!args.json, commandsDir: args.commandsDir });
    printJson({ commands });
    return;
  }

  if (cmd === 'describe') {
    const commandName = args.command || args._[0];
    if (!commandName) throw new Error('describe requires <name> or --command <name>');
    const params = parseKeyValues(args._.slice(args._[0] === commandName ? 1 : 0));
    printJson(describeCommand(commandName, { commandsDir: args.commandsDir, params }));
    return;
  }
  if (cmd === 'explain') {
    const input = args._.join(' ').trim();
    if (!input) throw new Error('explain requires natural language text');
    printJson(explainNaturalLanguage(input, { commandsDir: args.commandsDir }));
    return;
  }
  if (cmd === 'agent') {
    printJson(buildAgentManifest({ commandsDir: args.commandsDir }));
    return;
  }
  if (cmd === 'doctor') {
    const result = args.command
      ? doctorCommand(args.command, { commandsDir: args.commandsDir })
      : { environment: environmentDoctor(), commands: doctorAll({ commandsDir: args.commandsDir }) };
    printJson(result);
    return;
  }
  if (cmd === 'runs') {
    if (args.summary) printJson(summarizeRuns({ limit: args.limit }));
    else {
      const runs = listRuns({ limit: args.limit });
      printJson({ total: runs.length, runs });
    }
    return;
  }
  if (cmd === 'schedule') {
    const subcmd = args._[0] && !String(args._[0]).includes('=') ? args._[0] : (args.command ? 'plan' : 'list');
    const params = extractScheduleParams(args, subcmd);
    if (subcmd === 'plan') {
      const spec = buildScheduleSpec({
        id: args.id,
        command: args.command,
        cron: args.cron,
        timezone: args.timezone || 'local',
        dryRun: !args.executeReal,
        confirm: !!args.confirm,
        params
      });
      if (args.json) printJson(spec);
      else console.log(formatScheduleMarkdown(spec));
      return;
    }
    if (subcmd === 'install') {
      const result = installSchedule({
        id: args.id,
        command: args.command,
        cron: args.cron,
        timezone: args.timezone || 'local',
        operationDryRun: !!args.dryRun,
        commandDryRun: !!args.dryRunCommand,
        confirm: !!args.confirm,
        params
      });
      printJson(result);
      return;
    }
    if (subcmd === 'list') {
      printJson(listSchedules());
      return;
    }
    if (subcmd === 'status') {
      printJson(getScheduleStatus({ id: args.id }));
      return;
    }
    if (subcmd === 'remove') {
      printJson(removeSchedule({ id: args.id, dryRun: !!args.dryRun, confirm: !!args.confirm }));
      return;
    }
    throw new Error(`unknown schedule subcommand: ${subcmd}`);
  }
  if (cmd === 'docs') {
    const result = generateCommandDocs({ commandsDir: args.commandsDir, outputPath: args.output });
    if (args.json) printJson(result);
    else if (args.output) console.log(`Generated ${result.commands} command docs: ${args.output}`);
    else console.log(result.markdown);
    return;
  }
  if (cmd === 'init') {
    printJson(initCommandScaffold({ dir: args.dir, platform: args.platform, action: args.action, force: args.force }));
    return;
  }

  if (cmd === 'mcp') {
    await runMcpServer();
    return;
  }
  if (cmd === 'verify') {
    const commandName = args.command || args._[0];
    if (!commandName) throw new Error('verify requires <name> or --command <name>');
    const result = verifyCommand(commandName, { commandsDir: args.commandsDir });
    printJson({ ok: result.ok, file: result.file, errors: result.errors });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'ask') {
    const input = args._.join(' ').trim();
    if (!input) throw new Error('ask requires natural language text');
    if (args.dryRun && args.executeReal) throw new Error('--dry-run and --execute-real cannot be used together');
    if (args.executeReal && !args.confirm) throw new Error('--execute-real requires --confirm');
    const output = await runNaturalLanguage(input, { dryRun: !args.executeReal, confirm: !!args.confirm });
    if (args.json) printJson(output);
    else console.log(formatHumanReadable(output));
    return;
  }
  if (cmd === 'execute') {
    if (!args.command) throw new Error('execute requires --command');
    const params = extractExecuteParams(args);
    if (args.dryRun && args.executeReal) throw new Error('--dry-run and --execute-real cannot be used together');
    if (args.executeReal && !args.confirm) throw new Error('--execute-real requires --confirm');
    const result = await executeCommand(args.command, params, { dryRun: !args.executeReal, confirm: !!args.confirm, commandsDir: args.commandsDir });
    printJson(result);
    return;
  }
  if (cmd === 'learn') {
    const result = await learnAction({
      platform: args.platform,
      action: args.action,
      url: args.url,
      observeSeconds: args.observeSeconds,
      provider: args.provider,
      headless: !args.headed
    });
    printJson(result);
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`[platform-command] ${err.message}`);
  process.exit(1);
});

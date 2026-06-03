#!/usr/bin/env node
import { listCommands } from './command_store.js';
import { executeCommand } from './execute.js';
import { learnAction } from './learn.js';
import { formatHumanReadable, runNaturalLanguage } from './nl.js';
import { buildAgentManifest, describeCommand, explainNaturalLanguage } from './describe.js';
import { doctorAll, doctorCommand, environmentDoctor } from './doctor.js';
import { initCommandScaffold } from './init.js';
import { listRuns, summarizeRuns } from './runs.js';
import { buildScheduleSpec, formatScheduleMarkdown } from './schedule.js';
import { generateCommandDocs } from './docs.js';
import { parseKeyValues, printJson } from './utils.js';
import { verifyCommand } from './verify.js';
import { runMcpServer } from './mcp_server.js';

function help() {
  console.log(`platform-command

Usage:
  node src/cli.js --help
  node src/cli.js list [--json] [--commands-dir <dir>]
  node src/cli.js describe <name> [--json] [key=value ...]
  node src/cli.js explain "自然语言指令" [--json]
  node src/cli.js agent --json
  node src/cli.js doctor [--command <name>] [--json]
  node src/cli.js runs [--summary] [--limit 20]
  node src/cli.js schedule --command <name> --cron <expr> [--json] key=value ...
  node src/cli.js docs [--output <path>] [--commands-dir <dir>]
  node src/cli.js init --platform <name> --action <name> [--dir commands]
  node src/cli.js mcp
  node src/cli.js verify <name> [--commands-dir <dir>]
  node src/cli.js verify --command <name> [--commands-dir <dir>]
  node src/cli.js execute --command <name> [--commands-dir <dir>] [--dry-run] key=value ...
  node src/cli.js ask "自然语言指令" [--json] [--execute-real --confirm]
  node src/cli.js execute --command <name> --execute-real --confirm key=value ...  # experimental; currently blocked
  node src/cli.js learn --platform <name> --action <name> --url <url> [--observe-seconds 8] [--headed]

Examples:
  node src/cli.js verify demo.search_example
  node src/cli.js execute --command demo.search_example --dry-run keyword=abc
  node src/cli.js ask "在 GitHub 上，查看 zhaoxuya520/reverse-skill 的 issues，状态 all"
  node src/cli.js execute --command demo.workflow_example --dry-run keyword=abc limit=5
  node src/cli.js execute --command demo.workflow_example --execute-real --confirm keyword=abc limit=5
  node src/cli.js learn --platform demo --action inspect --url https://example.com --observe-seconds 3
  node src/cli.js mcp
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (['dryRun', 'confirm', 'headed', 'executeReal', 'json'].includes(key)) out[key] = true;
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
    const spec = buildScheduleSpec({
      command: args.command,
      cron: args.cron,
      timezone: args.timezone || 'local',
      dryRun: !args.executeReal,
      confirm: !!args.confirm,
      params: extractExecuteParams(args)
    });
    if (args.json) printJson(spec);
    else console.log(formatScheduleMarkdown(spec));
    return;
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

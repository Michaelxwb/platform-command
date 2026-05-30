#!/usr/bin/env node
import { listCommands } from './command_store.js';
import { executeCommand } from './execute.js';
import { learnAction } from './learn.js';
import { parseKeyValues, printJson } from './utils.js';
import { verifyCommand } from './verify.js';

function help() {
  console.log(`platform-command

Usage:
  node src/cli.js --help
  node src/cli.js list
  node src/cli.js verify --command <name>
  node src/cli.js execute --command <name> [--dry-run] key=value ...
  node src/cli.js execute --command <name> --execute-real --confirm key=value ...  # experimental; currently blocked
  node src/cli.js learn --platform <name> --action <name> --url <url> [--observe-seconds 8] [--headed]

Examples:
  node src/cli.js verify --command demo.search_example
  node src/cli.js execute --command demo.search_example --dry-run keyword=abc
  node src/cli.js execute --command demo.workflow_example --dry-run keyword=abc limit=5
  node src/cli.js execute --command demo.workflow_example --execute-real --confirm keyword=abc limit=5
  node src/cli.js learn --platform demo --action inspect --url https://example.com --observe-seconds 3
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (['dryRun', 'confirm', 'headed', 'executeReal'].includes(key)) out[key] = true;
      else out[key] = argv[++i];
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!cmd || cmd === '--help' || cmd === 'help') return help();
  if (cmd === 'list') return printJson({ commands: listCommands() });
  if (cmd === 'verify') {
    if (!args.command) throw new Error('verify requires --command');
    const result = verifyCommand(args.command);
    printJson({ ok: result.ok, file: result.file, errors: result.errors });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'execute') {
    if (!args.command) throw new Error('execute requires --command');
    const params = parseKeyValues(args._);
    if (args.dryRun && args.executeReal) throw new Error('--dry-run and --execute-real cannot be used together');
    if (args.executeReal && !args.confirm) throw new Error('--execute-real requires --confirm');
    const result = await executeCommand(args.command, params, { dryRun: !args.executeReal, confirm: !!args.confirm });
    printJson(result);
    return;
  }
  if (cmd === 'learn') {
    const result = await learnAction({
      platform: args.platform,
      action: args.action,
      url: args.url,
      observeSeconds: args.observeSeconds,
      headless: !args.headed
    });
    printJson({ status: result.status, runDir: result.runDir, title: result.report.domSummary.title, requestCount: result.report.network.requests.length });
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(`[platform-command] ${err.stack || err.message}`);
  process.exit(1);
});

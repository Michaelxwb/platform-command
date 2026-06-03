import path from 'node:path';

export function buildScheduleSpec({
  command,
  params = {},
  cron,
  timezone = 'local',
  dryRun = true,
  confirm = false,
  cwd = process.cwd(),
  nodeBin = 'node',
  cliPath = 'src/cli.js'
} = {}) {
  if (!command) throw new Error('schedule requires --command');
  if (!cron) throw new Error('schedule requires --cron');
  const args = [cliPath, 'execute', '--command', command];
  if (dryRun) args.push('--dry-run');
  else args.push('--execute-real');
  if (confirm) args.push('--confirm');
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    args.push(`${key}=${String(value)}`);
  }
  const resolvedCwd = path.resolve(cwd);
  const shellCommand = [nodeBin, ...args.map(shellQuote)].join(' ');
  return {
    kind: 'platform_command_schedule',
    command,
    cron,
    timezone,
    dryRun,
    confirm,
    cwd: resolvedCwd,
    shellCommand,
    systemAdapters: {
      cron: `${cron} cd ${shellQuote(resolvedCwd)} && ${shellCommand}`,
      systemdTimer: {
        serviceExecStart: `/bin/sh -lc ${shellQuote(`cd ${shellQuote(resolvedCwd)} && ${shellCommand}`)}`,
        timerOnCalendar: `cron:${cron}`
      },
      windowsTask: {
        program: nodeBin,
        arguments: args.join(' '),
        startIn: resolvedCwd,
        scheduleHint: cron
      }
    },
    note: 'This only generates a reusable schedule specification. It does not install host-level scheduled tasks.'
  };
}

export function formatScheduleMarkdown(spec) {
  return [
    '# platform-command schedule spec',
    '',
    `- command: ${spec.command}`,
    `- cron: ${spec.cron}`,
    `- timezone: ${spec.timezone}`,
    `- dryRun: ${spec.dryRun}`,
    `- confirm: ${spec.confirm}`,
    `- cwd: ${spec.cwd}`,
    '',
    '## Shell command',
    '',
    '```bash',
    spec.shellCommand,
    '```',
    '',
    '## Cron adapter',
    '',
    '```cron',
    spec.systemAdapters.cron,
    '```',
    '',
    '> This file is advisory only; install it with the host scheduler after user approval.'
  ].join('\n');
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

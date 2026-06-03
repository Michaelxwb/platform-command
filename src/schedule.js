import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MARKER_PREFIX = 'platform-command schedule';

export function buildScheduleSpec({
  id,
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
  const resolvedCwd = path.resolve(cwd);
  const normalizedParams = normalizeParams(params);
  const scheduleId = id || buildScheduleId({ command, cron, params: normalizedParams });
  const args = [cliPath, 'execute', '--command', command];
  if (dryRun) args.push('--dry-run');
  else args.push('--execute-real', '--confirm');
  for (const [key, value] of Object.entries(normalizedParams)) {
    if (value === undefined || value === null) continue;
    args.push(`${key}=${String(value)}`);
  }
  const shellCommand = [nodeBin, ...args.map(shellQuote)].join(' ');
  const cronCommand = `cd ${shellQuote(resolvedCwd)} && ${shellCommand}`;
  return {
    kind: 'platform_command_schedule',
    id: scheduleId,
    command,
    cron,
    timezone,
    dryRun,
    confirm: dryRun ? false : true,
    cwd: resolvedCwd,
    shellCommand,
    systemAdapters: {
      cron: `${cron} ${cronCommand}`,
      systemdTimer: {
        serviceExecStart: `/bin/sh -lc ${shellQuote(cronCommand)}`,
        timerOnCalendar: `cron:${cron}`
      },
      windowsTask: {
        program: nodeBin,
        arguments: args.join(' '),
        startIn: resolvedCwd,
        scheduleHint: cron
      }
    },
    note: 'This schedule can be installed into the host scheduler with schedule install --confirm.'
  };
}

export function buildCronBlock(spec) {
  return [
    `# ${MARKER_PREFIX} begin ${spec.id}`,
    `# command=${spec.command}`,
    `# timezone=${spec.timezone}`,
    `# dryRun=${spec.dryRun}`,
    `# cwd=${spec.cwd}`,
    spec.systemAdapters.cron,
    `# ${MARKER_PREFIX} end ${spec.id}`
  ].join('\n');
}

export function installSchedule(options = {}) {
  const operationDryRun = options.operationDryRun ?? options.dryRun ?? false;
  const spec = buildScheduleSpec({ ...options, dryRun: options.commandDryRun ?? options.scheduleDryRun ?? options.dryRunCommand ?? options.dryRun ?? true });
  if (!operationDryRun && !options.confirm) throw new Error('schedule install requires --confirm unless --dry-run is used');
  const existing = readCrontab(options);
  const schedules = parsePlatformSchedules(existing);
  const nextBlock = buildCronBlock(spec);
  const withoutSame = removeScheduleBlockText(existing, spec.id);
  const next = appendCronBlock(withoutSame, nextBlock);
  return {
    action: 'install',
    dryRun: !!operationDryRun,
    installed: !operationDryRun,
    replaced: schedules.some((item) => item.id === spec.id),
    id: spec.id,
    spec,
    cronBlock: nextBlock,
    previousCrontab: options.includeCrontab ? existing : undefined,
    nextCrontab: operationDryRun || options.includeCrontab ? next : undefined,
    backend: 'crontab',
    ...(operationDryRun ? {} : writeCrontab(next, options))
  };
}

export function listSchedules(options = {}) {
  const crontab = readCrontab(options);
  return {
    action: 'list',
    backend: 'crontab',
    schedules: parsePlatformSchedules(crontab)
  };
}

export function getScheduleStatus(options = {}) {
  const id = options.id;
  if (!id) throw new Error('schedule status requires --id');
  const schedules = listSchedules(options).schedules;
  const schedule = schedules.find((item) => item.id === id) || null;
  return {
    action: 'status',
    backend: 'crontab',
    id,
    found: !!schedule,
    schedule
  };
}

export function removeSchedule(options = {}) {
  const id = options.id;
  if (!id) throw new Error('schedule remove requires --id');
  if (!options.dryRun && !options.confirm) throw new Error('schedule remove requires --confirm unless --dry-run is used');
  const existing = readCrontab(options);
  const schedules = parsePlatformSchedules(existing);
  const found = schedules.some((item) => item.id === id);
  const next = removeScheduleBlockText(existing, id);
  return {
    action: 'remove',
    backend: 'crontab',
    id,
    dryRun: !!options.dryRun,
    removed: found && !options.dryRun,
    found,
    previousCrontab: options.includeCrontab ? existing : undefined,
    nextCrontab: options.dryRun || options.includeCrontab ? next : undefined,
    ...(options.dryRun ? {} : writeCrontab(next, options))
  };
}

export function parsePlatformSchedules(crontabText = '') {
  const lines = String(crontabText || '').split(/\r?\n/);
  const schedules = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = lines[i].match(/^# platform-command schedule begin (.+)$/);
    if (!begin) continue;
    const id = begin[1].trim();
    const block = [lines[i]];
    let command;
    let timezone;
    let dryRun;
    let cwd;
    let cronLine = '';
    let endLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      block.push(lines[j]);
      const line = lines[j];
      if (line.startsWith('# command=')) command = line.slice('# command='.length);
      else if (line.startsWith('# timezone=')) timezone = line.slice('# timezone='.length);
      else if (line.startsWith('# dryRun=')) dryRun = line.slice('# dryRun='.length) === 'true';
      else if (line.startsWith('# cwd=')) cwd = line.slice('# cwd='.length);
      else if (!line.startsWith('#') && line.trim()) cronLine = line;
      if (line === `# ${MARKER_PREFIX} end ${id}`) {
        endLine = j;
        break;
      }
    }
    if (endLine !== -1) {
      schedules.push({ id, command, timezone, dryRun, cwd, cronLine, block: block.join('\n') });
      i = endLine;
    }
  }
  return schedules;
}

export function formatScheduleMarkdown(spec) {
  return [
    '# platform-command schedule spec',
    '',
    `- id: ${spec.id}`,
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
    '> Install with `platform-command schedule install --confirm ...`; dry-run is available for preview.'
  ].join('\n');
}

function readCrontab(options = {}) {
  if (typeof options.readCrontab === 'function') return options.readCrontab();
  if (typeof options.crontabText === 'string') return options.crontabText;
  try {
    return execFileSync(options.crontabBin || 'crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    if (err.status === 1 || /no crontab for|no crontab/i.test(stderr)) return '';
    throw new Error(`failed to read crontab: ${stderr.trim() || err.message}`);
  }
}

function writeCrontab(text, options = {}) {
  if (typeof options.writeCrontab === 'function') return options.writeCrontab(text) || { written: true };
  execFileSync(options.crontabBin || 'crontab', ['-'], { input: text, encoding: 'utf8' });
  return { written: true };
}

function appendCronBlock(existing, block) {
  const trimmed = String(existing || '').replace(/[ \t]+$/gm, '').replace(/\n*$/, '');
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

function removeScheduleBlockText(text, id) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `# ${MARKER_PREFIX} begin ${id}`) {
      while (i < lines.length && lines[i] !== `# ${MARKER_PREFIX} end ${id}`) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, out.length ? '\n' : '');
}

function buildScheduleId({ command, cron, params }) {
  const hash = crypto.createHash('sha1').update(JSON.stringify({ command, cron, params })).digest('hex').slice(0, 10);
  const slug = String(command).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 40);
  return `${slug}-${hash}`;
}

function normalizeParams(params = {}) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null));
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

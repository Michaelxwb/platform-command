// @ts-nocheck
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadCommand } from './command_store.js';
import { requiresBrowser } from './requirements.js';

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
  nodeBin = undefined,
  cliPath = undefined,
  cliBin = 'platform-command'
} = {}) {
  if (!command) throw new Error('schedule requires --command');
  if (!cron) throw new Error('schedule requires --cron');
  const resolvedCwd = path.resolve(cwd);
  const normalizedParams = normalizeParams(params);
  const scheduleId = id || buildScheduleId({ command, cron, params: normalizedParams });
  const usesNodeEntrypoint = !!cliPath;
  const program = usesNodeEntrypoint ? (nodeBin || 'node') : cliBin;
  const args = usesNodeEntrypoint ? [cliPath, 'execute', '--command', command] : ['execute', '--command', command];
  if (dryRun) args.push('--dry-run');
  else args.push('--execute-real', '--confirm');
  for (const [key, value] of Object.entries(normalizedParams)) {
    if (value === undefined || value === null) continue;
    args.push(`${key}=${String(value)}`);
  }
  const shellCommand = [program, ...args.map(posixShellQuote)].join(' ');
  const cronCommand = `cd ${posixShellQuote(resolvedCwd)} && ${shellCommand}`;
  const windowsTaskRun = buildWindowsTaskRun({ cwd: resolvedCwd, nodeBin: program, args });
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
        serviceExecStart: `/bin/sh -lc ${posixShellQuote(cronCommand)}`,
        timerOnCalendar: `cron:${cron}`
      },
      windowsTask: {
        program,
        arguments: args.map(windowsArgQuote).join(' '),
        taskRun: windowsTaskRun,
        startIn: resolvedCwd,
        scheduleHint: cron
      }
    },
    risk: buildScheduleRisk({ dryRun, confirm: dryRun ? false : true, schedulerWrite: false }),
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

// Warn (do not block) when an unattended real run needs a logged-in browser.
function buildExecutionWarnings(spec, options = {}) {
  const warnings = [];
  if (spec.dryRun) return warnings; // scheduled dry-run never needs a live session
  let command;
  try {
    command = loadCommand(spec.command, { commandsDir: options.commandsDir }).command;
  } catch {
    return warnings; // command not found here; install layer doesn't enforce existence
  }
  if (requiresBrowser(command)) {
    warnings.push({
      code: 'REQUIRES_INTERACTIVE_SESSION',
      message: `Command '${spec.command}' needs a logged-in browser session (session/ui). An unattended scheduled --execute-real will fail unless a logged-in browser / daemon is present at trigger time. Keep it dry-run, or trigger it with a person present.`
    });
  }
  return warnings;
}

// Pick the host scheduler backend. OS is a hard fact, so selecting by platform
// is fine (not a "magic guess"). Injected crontab hooks force the crontab path.
function detectBackend(options = {}) {
  if (options.backend) return options.backend;
  if (typeof options.readCrontab === 'function' || typeof options.crontabText === 'string' || typeof options.writeCrontab === 'function') return 'crontab';
  if (typeof options.runSchtasks === 'function') return 'schtasks';
  if (process.platform === 'win32') return commandExists(options.schtasksBin || 'schtasks', ['/Query']) ? 'schtasks' : 'none';
  return commandExists(options.crontabBin || 'crontab', ['-l']) ? 'crontab' : 'none';
}

function commandExists(bin, args = []) {
  const probe = spawnSync(bin, args, { stdio: 'ignore' });
  return !(probe.error && probe.error.code === 'ENOENT');
}

export function installSchedule(options = {}) {
  const operationDryRun = options.operationDryRun ?? options.dryRun ?? false;
  const spec = buildScheduleSpec({ ...options, dryRun: options.commandDryRun ?? options.scheduleDryRun ?? options.dryRunCommand ?? false });
  const warnings = buildExecutionWarnings(spec, options);
  const backend = detectBackend(options);
  if (backend === 'none') {
    return {
      action: 'install',
      backend: 'none',
      installed: false,
      dryRun: !!operationDryRun,
      id: spec.id,
      spec,
      warnings,
      risk: buildScheduleRisk({ dryRun: spec.dryRun, schedulerWrite: false }),
      reason: 'No supported scheduler backend on this platform (need crontab or schtasks); use spec.systemAdapters to install manually.'
    };
  }
  if (!operationDryRun && !options.confirm) throw new Error('schedule install requires --confirm unless --dry-run is used');
  if (backend === 'schtasks') return installViaSchtasks(spec, { ...options, operationDryRun, warnings });
  return installViaCrontab(spec, { ...options, operationDryRun, warnings });
}

function installViaCrontab(spec, options) {
  const existing = readCrontab(options);
  const schedules = parsePlatformSchedules(existing);
  const nextBlock = buildCronBlock(spec);
  const withoutSame = removeScheduleBlockText(existing, spec.id);
  const next = appendCronBlock(withoutSame, nextBlock);
  return {
    action: 'install',
    backend: 'crontab',
    dryRun: !!options.operationDryRun,
    installed: !options.operationDryRun,
    replaced: schedules.some((item) => item.id === spec.id),
    id: spec.id,
    spec,
    warnings: options.warnings,
    risk: buildScheduleRisk({ dryRun: spec.dryRun, schedulerWrite: !options.operationDryRun }),
    cronBlock: nextBlock,
    previousCrontab: options.includeCrontab ? existing : undefined,
    nextCrontab: options.operationDryRun || options.includeCrontab ? next : undefined,
    ...(options.operationDryRun ? {} : writeCrontab(next, options))
  };
}

function installViaSchtasks(spec, options) {
  const mapped = cronToSchtasks(spec.cron);
  if (!mapped) {
    return {
      action: 'install',
      backend: 'schtasks',
      installed: false,
      dryRun: !!options.operationDryRun,
      id: spec.id,
      spec,
      warnings: options.warnings,
      risk: buildScheduleRisk({ dryRun: spec.dryRun, schedulerWrite: false }),
      reason: `cron '${spec.cron}' cannot be mapped to a schtasks schedule; install manually via Task Scheduler using spec.systemAdapters.windowsTask.`
    };
  }
  const taskName = `\\platform-command\\${spec.id}`;
  const taskRun = spec.systemAdapters.windowsTask.taskRun;
  const args = ['/Create', '/TN', taskName, '/TR', taskRun, '/F', ...mapped.flags];
  if (!options.operationDryRun) schtasksRun(args, options);
  return {
    action: 'install',
    backend: 'schtasks',
    installed: !options.operationDryRun,
    dryRun: !!options.operationDryRun,
    id: spec.id,
    taskName,
    spec,
    warnings: options.warnings,
    schtasksArgs: args,
    schedule: mapped.flags.join(' '),
    risk: buildScheduleRisk({ dryRun: spec.dryRun, schedulerWrite: !options.operationDryRun }),
    ...(options.operationDryRun ? {} : { written: true })
  };
}

export function listSchedules(options = {}) {
  const backend = detectBackend(options);
  if (backend === 'schtasks') return listViaSchtasks(options);
  if (backend === 'none') return { action: 'list', backend: 'none', schedules: [] };
  return { action: 'list', backend: 'crontab', schedules: parsePlatformSchedules(readCrontab(options)) };
}

function listViaSchtasks(options) {
  let out = '';
  try {
    out = schtasksRun(['/Query', '/FO', 'CSV', '/NH'], options);
  } catch {
    out = '';
  }
  const schedules = String(out)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^"([^"]*platform-command[\\/][^"]+)"/i);
      if (!match) return null;
      const taskName = match[1];
      const id = taskName.split(/[\\/]/).pop();
      return { id, taskName, backend: 'schtasks' };
    })
    .filter(Boolean);
  return { action: 'list', backend: 'schtasks', schedules };
}

export function getScheduleStatus(options = {}) {
  const id = options.id;
  if (!id) throw new Error('schedule status requires --id');
  const result = listSchedules(options);
  const schedule = result.schedules.find((item) => item.id === id) || null;
  return { action: 'status', backend: result.backend, id, found: !!schedule, schedule };
}

export function removeSchedule(options = {}) {
  const id = options.id;
  if (!id) throw new Error('schedule remove requires --id');
  if (!options.dryRun && !options.confirm) throw new Error('schedule remove requires --confirm unless --dry-run is used');
  const backend = detectBackend(options);
  if (backend === 'schtasks') return removeViaSchtasks(id, options);
  if (backend === 'none') return { action: 'remove', backend: 'none', id, removed: false, found: false, reason: 'No supported scheduler backend.' };
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

function removeViaSchtasks(id, options) {
  const taskName = `\\platform-command\\${id}`;
  if (options.dryRun) return { action: 'remove', backend: 'schtasks', id, taskName, dryRun: true, removed: false };
  let removed = true;
  try {
    schtasksRun(['/Delete', '/TN', taskName, '/F'], options);
  } catch {
    removed = false;
  }
  return { action: 'remove', backend: 'schtasks', id, taskName, removed, found: removed };
}

function schtasksRun(args, options = {}) {
  if (typeof options.runSchtasks === 'function') return options.runSchtasks(args);
  return execFileSync(options.schtasksBin || 'schtasks', args, { encoding: 'utf8' });
}

// cron (5 fields) -> schtasks schedule flags. Only the directly mappable subset
// is supported; anything richer returns null so the caller can degrade to a
// manual spec instead of installing a wrong/partial task.
export function cronToSchtasks(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const num = (v) => /^\d+$/.test(v);
  const intIn = (v, minValue, maxValue) => num(v) && Number(v) >= minValue && Number(v) <= maxValue;
  const pad = (v) => String(Number(v)).padStart(2, '0');
  const monthlyWild = dom === '*' && mon === '*';

  if (min === '*' && hour === '*' && monthlyWild && dow === '*') return { flags: ['/SC', 'MINUTE', '/MO', '1'] };
  const everyN = min.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && monthlyWild && dow === '*') {
    const interval = Number(everyN[1]);
    if (interval < 1 || interval > 1439) return null;
    return { flags: ['/SC', 'MINUTE', '/MO', String(interval)] };
  }
  if (intIn(min, 0, 59) && hour === '*' && monthlyWild && dow === '*') return { flags: ['/SC', 'HOURLY', '/MO', '1', '/ST', `00:${pad(min)}`] };
  if (intIn(min, 0, 59) && intIn(hour, 0, 23) && monthlyWild && dow === '*') return { flags: ['/SC', 'DAILY', '/ST', `${pad(hour)}:${pad(min)}`] };
  if (intIn(min, 0, 59) && intIn(hour, 0, 23) && dom === '*' && mon === '*' && intIn(dow, 0, 7)) {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    return { flags: ['/SC', 'WEEKLY', '/D', days[Number(dow) % 7], '/ST', `${pad(hour)}:${pad(min)}`] };
  }
  return null;
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
    if (err.code === 'ENOENT') return ''; // crontab binary missing (e.g. Windows): treat as empty, don't crash
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

function posixShellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\''`)}'`;
}

function windowsArgQuote(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"^&|<>()%]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function windowsCmdQuote(value) {
  return windowsArgQuote(value).replace(/[&|<>()^]/g, '^$&');
}

function buildWindowsTaskRun({ cwd, nodeBin, args }) {
  const command = [nodeBin, ...args].map(windowsCmdQuote).join(' ');
  return `cmd.exe /d /s /c "cd /d ${windowsCmdQuote(cwd)} && ${command}"`;
}

function buildScheduleRisk({ dryRun, schedulerWrite = false }) {
  return {
    commandExecutionMode: dryRun ? 'dry-run' : 'real',
    requiresConfirm: !dryRun || schedulerWrite,
    schedulerWrite: !!schedulerWrite,
    managedScope: 'platform-command-block-only'
  };
}

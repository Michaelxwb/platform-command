// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runWithConcurrency } from '../shared/utils.js';

// 兼容再导出（既有测试/调用从 daemon 引用 runWithConcurrency）
export { runWithConcurrency };

// 通用调度守护进程（FEAT-04）：平台无关。
// - schedule 条目：{ id, command, params, schedule:{weekday|monthday,time}, kind:'weekly'|'monthly' }
// - 并发 worker 池（maxWorkers，超出排队）
// - 心跳文件 + 重启时漏执行回放（停机期间应触发的任务）
// - 可插拔 notifier（默认企业微信 webhook）
// - 到点调框架 executeCommand（认命令名不认平台）——原子/组合命令皆可被排期。

const WEEKDAY_INDEX = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };
const DAEMON_DIR = path.join(ROOT, 'runs', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'scheduler.pid');
const HEARTBEAT_FILE = path.join(DAEMON_DIR, 'heartbeat.txt');

function parseHM(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// 枚举 (since, until] 区间内某调度应触发的所有时间点（复刻 scheduler_daemon._iter_trigger_times）。
export function iterTriggerTimes(schedule, kind, since, until) {
  const hm = parseHM(schedule?.time);
  if (!hm) return [];
  const hits = [];

  if (kind === 'weekly') {
    const target = WEEKDAY_INDEX[String(schedule.weekday || '').toUpperCase()];
    if (target === undefined) return [];
    let cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate(), hm.hh, hm.mm, 0, 0);
    if (cursor < since) cursor = addDays(cursor, 1);
    while (cursor <= until) {
      // JS getDay: Sun=0..Sat=6 → 转 Mon=0..Sun=6
      const dow = (cursor.getDay() + 6) % 7;
      if (dow === target) hits.push(new Date(cursor));
      cursor = addDays(cursor, 1);
    }
    return hits;
  }

  if (kind === 'monthly') {
    const targetDay = Number(schedule.monthday);
    if (!(targetDay >= 1 && targetDay <= 31)) return [];
    let cursor = new Date(since.getFullYear(), since.getMonth(), 1);
    while (cursor <= until) {
      const ld = lastDayOfMonth(cursor.getFullYear(), cursor.getMonth());
      const day = Math.min(targetDay, ld); // 月末边界：31 当 2 月 → 取当月最后一天
      const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), day, hm.hh, hm.mm, 0, 0);
      if (candidate > since && candidate <= until) hits.push(candidate);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    return hits;
  }

  return [];
}

// 停机期间漏执行的任务（每个 schedule entry 的应触发时刻列表）。
export function computeMissedJobs(entries, lastActive, now) {
  const missed = [];
  for (const entry of entries) {
    const hits = iterTriggerTimes(entry.schedule, entry.kind, lastActive, now);
    if (hits.length) missed.push({ id: entry.id, command: entry.command, params: entry.params, kind: entry.kind, hits });
  }
  return missed;
}

// 选出本轮到点、且未在队列/执行中的 job（按 id 去重，避免长任务期间重复入队）。
export function selectDueJobs(entries, lastTick, tickNow, pendingIds = new Set()) {
  return entries.filter((e) => !pendingIds.has(e.id) && iterTriggerTimes(e.schedule, e.kind, lastTick, tickNow).length > 0);
}

export function readHeartbeat(file = HEARTBEAT_FILE) {
  try {
    const ts = fs.readFileSync(file, 'utf8').trim();
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function writeHeartbeat(file = HEARTBEAT_FILE, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, now.toISOString(), 'utf8');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function daemonStatus(pidFile = PID_FILE) {
  if (!fs.existsSync(pidFile)) return { running: false };
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!pid || !pidAlive(pid)) {
    try { fs.rmSync(pidFile); } catch { /* ignore */ }
    return { running: false };
  }
  return { running: true, pid };
}

// 从某平台的 store 目录加载调度条目：扫 store/*.json，按 weekly_schedule/monthly_schedule
// 字段映射为指向业务命令（commandMap）的条目。company_id = store key。
export function loadScheduleEntries(commandsDir, platform, commandMap, readStoreDir = defaultReadStoreDir) {
  const entries = [];
  const dir = path.join(commandsDir, platform, 'store');
  for (const { key, config } of readStoreDir(dir)) {
    for (const [kind, field] of [['weekly', 'weekly_schedule'], ['monthly', 'monthly_schedule']]) {
      const schedule = config?.[field];
      if (!schedule) continue;
      entries.push({
        id: `${key}_${kind}`,
        command: commandMap[kind],
        params: { companyId: key },
        schedule,
        kind
      });
    }
  }
  return entries;
}

function defaultReadStoreDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    try {
      out.push({ key: name.replace(/\.json$/, ''), config: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) });
    } catch { /* skip broken */ }
  }
  return out;
}

// 默认通知器：企业微信 webhook（无 webhook 时静默；失败仅返回 false 不抛）。
export async function webhookNotifier(text, webhookUrl = process.env.PLATFORM_COMMAND_WEBHOOK_URL) {
  if (!webhookUrl) return false;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } })
    });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stopDaemon(pidFile = PID_FILE) {
  const st = daemonStatus(pidFile);
  if (!st.running) return { stopped: false, reason: 'not running' };
  try { process.kill(st.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(pidFile); } catch { /* ignore */ }
  return { stopped: true, pid: st.pid };
}

// 常驻调度守护进程。建立在已测原语之上（loadScheduleEntries / iterTriggerTimes /
// runWithConcurrency / 心跳 / computeMissedJobs）。轮询有 sleep + 重扫配置感知变化。
export async function startDaemon(options = {}) {
  const existing = daemonStatus();
  if (existing.running) return { started: false, reason: 'already running', pid: existing.pid };

  const maxWorkers = Number(options.maxWorkers || process.env.PLATFORM_COMMAND_MAX_WORKERS || 3);
  const scanInterval = Number(options.scanIntervalMs || 60000);
  const notifier = options.notifier || webhookNotifier;
  const commandsDir = options.commandsDir || path.join(ROOT, 'commands');
  const platform = options.platform || 'mss';
  const commandMap = options.commandMap || { weekly: 'mss.export_weekly', monthly: 'mss.export_monthly' };

  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.rmSync(PID_FILE); } catch { /* ignore */ } };
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  // 漏执行回放（停机期间应触发的任务）
  const lastActive = readHeartbeat();
  const now = new Date();
  if (lastActive) {
    const missed = computeMissedJobs(loadScheduleEntries(commandsDir, platform, commandMap), lastActive, now);
    if (missed.length) {
      await notifier(`【调度】启动：停机期间检测到 ${missed.length} 项漏执行：\n`
        + missed.map((m) => `- ${m.id}（应触发 ${m.hits.length} 次）`).join('\n'));
    }
  }
  await notifier(`【调度】守护进程已启动[PID:${process.pid}]，并发上限 ${maxWorkers}`);
  writeHeartbeat();

  if (options.once) { cleanup(); return { started: true, pid: process.pid, once: true }; }

  // 持久队列 + 常驻 worker（对齐 skill）：扫描只负责入队 + 写心跳，与 worker 消费解耦，
  // 长任务（导出最长 30min）不阻塞扫描/心跳，空闲 worker 立即领新活。
  const queue = [];
  const pending = new Set();
  const idlePollMs = Number(options.idlePollMs || 1000);
  const runJob = options.runJob || (async (job) => {
    const { executeCommand } = await import('../engine/execute.js');
    await executeCommand(job.command, job.params, { dryRun: false, confirm: true });
  });

  const workerLoop = async () => {
    while (true) {
      const job = queue.shift();
      if (!job) { await sleep(idlePollMs); continue; } // 队列空：sleep 轮询，不忙等（RULE-07）
      try {
        await runJob(job);
        await notifier(`【调度】完成 ${job.id}`);
      } catch (err) {
        await notifier(`【调度】失败 ${job.id}: ${err.message}`);
      } finally {
        pending.delete(job.id);
      }
    }
  };

  const scanLoop = async () => {
    let lastTick = new Date();
    while (true) {
      await sleep(scanInterval);
      try {
        const tickNow = new Date();
        const entries = loadScheduleEntries(commandsDir, platform, commandMap); // 重扫感知配置变化
        for (const e of selectDueJobs(entries, lastTick, tickNow, pending)) {
          pending.add(e.id);
          queue.push(e);
        }
        lastTick = tickNow;
        writeHeartbeat(); // 每轮都写，不受长任务阻塞
      } catch (err) {
        try { await notifier(`【调度】扫描异常（已跳过本轮）：${err.message}`); } catch { /* notifier 也失败则忽略 */ }
      }
    }
  };

  // scan 与 maxWorkers 个 worker 并行常驻；任一不应自然结束。
  await Promise.all([scanLoop(), ...Array.from({ length: Math.max(1, maxWorkers) }, () => workerLoop())]);
}

export const DAEMON_PATHS = { DAEMON_DIR, PID_FILE, HEARTBEAT_FILE };

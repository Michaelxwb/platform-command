// platform-command 会话导出器（Service Worker / MV3）
// 监控「配置白名单域名」的 cookie 变化，导出为 Playwright storageState —— platform-command 直接可用，
// 覆盖式写入 Downloads 下固定文件。通用转换（任意站点）+ 可配置域名（仅白名单触发）+ 自动覆盖最新会话。

const KEYS = {
  domains: 'monitoredDomains',
  filename: 'outputFilename',
  minInterval: 'minIntervalSec',
  recent: 'recentFingerprints',
  lastExport: 'lastExport'
};

const DEFAULTS = {
  // 默认白名单；options 页可改。注意：这里的域名必须与命令实际请求的 host 一致，
  // 否则框架按 host 取 cookie 时匹配不上（见 README）。
  domains: ['soar.sea.sangfor.com', 'soar.sangfor.com.cn'],
  filename: 'platform-command/storage-state.json',
  minIntervalSec: 60 // 两次下载最小间隔，挡住轮换 cookie 造成的频繁下载
};

const DEBOUNCE_DELAY = 1500; // 合并突发的 cookie 变化
const RECENT_MAX = 8;        // 记住最近 N 个状态指纹，抑制来回横跳的重复下载
let debounceTimer = null;

// chrome.cookies.sameSite → Playwright storageState sameSite
const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };

function normalizeDomain(d) {
  return String(d || '').trim().replace(/^\./, '').toLowerCase();
}

async function getConfig() {
  const r = await chrome.storage.local.get([KEYS.domains, KEYS.filename, KEYS.minInterval]);
  const raw = Array.isArray(r[KEYS.domains]) && r[KEYS.domains].length ? r[KEYS.domains] : DEFAULTS.domains;
  const min = Number(r[KEYS.minInterval]);
  return {
    domains: [...new Set(raw.map(normalizeDomain).filter(Boolean))],
    filename: r[KEYS.filename] || DEFAULTS.filename,
    minIntervalSec: Number.isFinite(min) && min >= 0 ? min : DEFAULTS.minIntervalSec
  };
}

// 触发判断：变化的 cookie 域名是否落在白名单内（含父/子域）。
function domainMatches(cookieDomain, monitored) {
  const d = normalizeDomain(cookieDomain);
  return monitored.some((m) => d === m || d.endsWith(`.${m}`) || m.endsWith(`.${d}`));
}

// 通用转换：chrome.cookies.Cookie → Playwright storageState cookie（适用任意站点）。
function toStateCookie(c) {
  const sameSite = SAME_SITE[c.sameSite] || 'Lax';
  return {
    name: c.name,
    value: c.value,
    domain: c.domain, // 保留前导点；框架匹配时会 strip
    path: c.path || '/',
    expires: c.session || !c.expirationDate ? -1 : Math.floor(c.expirationDate),
    httpOnly: !!c.httpOnly, // ★ getAll 能拿到 httpOnly（soc-token/csrf_token 靠这个）
    secure: !!c.secure,
    // Playwright 对 sameSite=None 通常要求 secure，缺则降级为 Lax，避免 storageState 载入报错。
    sameSite: sameSite === 'None' && !c.secure ? 'Lax' : sameSite
  };
}

// 逐个白名单域名取 cookie，合并去重成一份 storageState（多平台共存，框架按 host 自动分流）。
async function collectStorageState(domains) {
  const seen = new Map();
  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const c of cookies) {
      const sc = toStateCookie(c);
      seen.set(`${sc.name}\n${sc.domain}\n${sc.path}`, sc); // 后者覆盖前者
    }
  }
  const cookies = [...seen.values()].sort((a, b) =>
    `${a.domain}${a.name}`.localeCompare(`${b.domain}${b.name}`));
  return { cookies, origins: [] };
}

async function writeState(state, filename) {
  const json = JSON.stringify(state, null, 2);
  // data: URL（service worker 无 createObjectURL）；encodeURIComponent 避免 btoa 大字符串爆栈。
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' });
}

// 导出主流程：仅白名单域名、内容变化才覆盖写。两层防抖：
//   1) 最近状态记忆：指纹在最近 N 个里见过（含来回横跳的两态）→ 跳过，不重复下载。
//   2) 节流：距上次下载不足 minIntervalSec → 跳过（高基数轮换 cookie 兜底；alarm 会补写最新）。
// force=true（手动「立即导出」）绕过两层，强制写一次。
async function exportSession(force = false) {
  const { domains, filename, minIntervalSec } = await getConfig();
  if (!domains.length) return null;
  const state = await collectStorageState(domains);
  if (!state.cookies.length) return null;

  const fingerprint = JSON.stringify(state.cookies.map((c) => [c.name, c.domain, c.path, c.value]));
  const store = await chrome.storage.local.get([KEYS.recent, KEYS.lastExport]);
  const recent = Array.isArray(store[KEYS.recent]) ? store[KEYS.recent] : [];

  if (!force) {
    if (recent.includes(fingerprint)) return null; // 最近见过的状态（含横跳两态）
    const lastAt = store[KEYS.lastExport]?.at || 0;
    if (Date.now() - lastAt < minIntervalSec * 1000) return null; // 节流
  }

  await writeState(state, filename);
  const nextRecent = [fingerprint, ...recent.filter((f) => f !== fingerprint)].slice(0, RECENT_MAX);
  const lastExport = { at: Date.now(), count: state.cookies.length, domains: domains.length, filename };
  await chrome.storage.local.set({ [KEYS.recent]: nextRecent, [KEYS.lastExport]: lastExport });
  console.log(`[platform-command] 导出 storageState：${state.cookies.length} cookies（${domains.length} 域）→ ${filename}`);
  return lastExport;
}

function scheduleExport() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    exportSession(false).catch((e) => console.error('[platform-command] 导出失败:', e));
  }, DEBOUNCE_DELAY);
}

async function seedDefaults() {
  const r = await chrome.storage.local.get(KEYS.domains);
  if (!Array.isArray(r[KEYS.domains])) {
    await chrome.storage.local.set({ [KEYS.domains]: DEFAULTS.domains, [KEYS.filename]: DEFAULTS.filename });
  }
}

// 触发器：白名单域名 cookie 变化即导出（需求 2：仅配置域名触发）。
chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const { domains } = await getConfig();
  if (domainMatches(cookie.domain, domains)) scheduleExport();
});

// 兜底：定时重扫，补漏 + 启动时刷新。
function ensureAlarm() {
  chrome.alarms.create('pc-session-export', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(async () => { await seedDefaults(); ensureAlarm(); scheduleExport(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); scheduleExport(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pc-session-export') scheduleExport(); });

// options 页「立即导出」按钮。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'exportNow') {
    exportSession(true) // 手动强制导出，绕过去抖/节流
      .then((info) => sendResponse({ ok: true, info: info || null }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  }
  return false;
});

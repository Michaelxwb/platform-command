const KEYS = { domains: 'monitoredDomains', filename: 'outputFilename', minInterval: 'minIntervalSec', lastExport: 'lastExport' };
const DEFAULTS = { domains: ['soar.sea.sangfor.com', 'soar.sangfor.com.cn'], filename: 'platform-command/storage-state.json', minIntervalSec: 60 };

const $ = (id) => document.getElementById(id);

function toast(text, ok = true) {
  const el = $('toast');
  el.textContent = text;
  el.style.color = ok ? '#059669' : '#dc2626';
  if (text) setTimeout(() => { el.textContent = ''; }, 4000);
}

function parseDomains(text) {
  return [...new Set(text.split('\n').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))];
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function render() {
  const r = await chrome.storage.local.get([KEYS.domains, KEYS.filename, KEYS.minInterval, KEYS.lastExport]);
  const domains = Array.isArray(r[KEYS.domains]) && r[KEYS.domains].length ? r[KEYS.domains] : DEFAULTS.domains;
  const filename = r[KEYS.filename] || DEFAULTS.filename;
  const min = Number(r[KEYS.minInterval]);
  $('domains').value = domains.join('\n');
  $('filename').value = filename;
  $('minInterval').value = Number.isFinite(min) && min >= 0 ? min : DEFAULTS.minIntervalSec;
  $('stateText').textContent = `监控中（${domains.length} 个域）`;
  const last = r[KEYS.lastExport];
  $('lastExport').textContent = last
    ? `最近导出：${fmtTime(last.at)} · ${last.count} cookies`
    : '尚未导出（登录目标站点或点「立即导出」）';
  // 路径提示按系统显示：Windows 用 %USERPROFILE%\Downloads\ 反斜杠，mac/linux 用 ~/Downloads/。
  const info = await chrome.runtime.getPlatformInfo();
  const shown = info.os === 'win'
    ? `%USERPROFILE%\\Downloads\\${filename.replace(/\//g, '\\')}`
    : `~/Downloads/${filename}`;
  $('outPath').innerHTML = `输出：<code>${shown}</code>`;
}

async function save() {
  const domains = parseDomains($('domains').value);
  const filename = $('filename').value.trim() || DEFAULTS.filename;
  if (!domains.length) { toast('至少配置一个域名', false); return false; }
  const minRaw = Number($('minInterval').value);
  const minIntervalSec = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : DEFAULTS.minIntervalSec;
  await chrome.storage.local.set({ [KEYS.domains]: domains, [KEYS.filename]: filename, [KEYS.minInterval]: minIntervalSec });
  toast(`已保存：${domains.length} 个域名`);
  return true;
}

$('save').addEventListener('click', save);
$('exportNow').addEventListener('click', async () => {
  if (!(await save())) return;
  chrome.runtime.sendMessage({ action: 'exportNow' }, async (resp) => {
    if (chrome.runtime.lastError) { toast(chrome.runtime.lastError.message, false); return; }
    if (resp && resp.ok) {
      toast(resp.info ? `已导出 ${resp.info.count} cookies` : '会话无变化（已是最新）');
      await render();
    } else {
      toast(`导出失败：${(resp && resp.error) || '无匹配 cookie'}`, false);
    }
  });
});

render();

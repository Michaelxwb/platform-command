// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

// 多站点（同一套命令打不同实例，如 soar 国内/海外）host 解析层。
// 命令包配置 commands/<platform>/config/sites.json：
//   { "default": "sea", "sites": { "sea": "https://soar.sea.sangfor.com", "cn": "https://soar.sangfor.com.cn" } }
// 选定优先级（对齐 platform-rules：环境变量 > 配置文件 > 默认值，再让 per-call param 最高）：
//   params.site > env PLATFORM_COMMAND_SITE > config.default
// 无配置文件 / 未选定 → 返回 null（不改写，沿用命令内默认 host），保证向后兼容。

const ENV_SITE = 'PLATFORM_COMMAND_SITE';

function loadSitesConfig(commandDir) {
  if (!commandDir) return null;
  const file = path.join(commandDir, 'config', 'sites.json');
  if (!fs.existsSync(file)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && cfg.sites && typeof cfg.sites === 'object' ? cfg : null;
  } catch {
    return null; // 配置损坏不致命：退回命令内默认 host
  }
}

export function resolveSiteOrigin(params = {}, options = {}) {
  const cfg = loadSitesConfig(options.commandDir);
  if (!cfg) return null;
  const wanted = String(params.site || process.env[ENV_SITE] || cfg.default || '').trim();
  if (!wanted) return null;
  const base = cfg.sites[wanted];
  if (!base) {
    throw new Error(`未知 site '${wanted}'，可选: ${Object.keys(cfg.sites).join(', ')}（commands/<platform>/config/sites.json）`);
  }
  const url = new URL(base);
  return { name: wanted, origin: url.origin, host: url.hostname };
}

// 把 url 的 origin 换成选定站点的 origin（保留 path/query/hash）；site 为空则原样返回。
export function applySiteOrigin(url, site) {
  if (!site || !url) return url;
  try {
    const u = new URL(url);
    return `${site.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url; // 非绝对 URL（如分页相对游标）不动
  }
}

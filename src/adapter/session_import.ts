// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../shared/utils.js';
import { readStorageState, chromeLaunchOptions } from './playwright_adapter.js';

// 本地登录态（storageState）导入能力（平台无关），与服务器侧 deploy/import-storage-state.sh 对称。
// 任何用 browser_session_cookie + 拦截/UI 的命令（导出等）都依赖它。

const DEFAULT_STATE = path.join(ROOT, '.platform-command', 'storage-state.json');

export function defaultStatePath() {
  return process.env.PLATFORM_COMMAND_STORAGE_STATE || DEFAULT_STATE;
}

// 把浏览器 Cookie 整串转成 Playwright storageState 并原子落盘（复刻 skill 用 cookies.txt 的做法）。
export function importCookieState({ host, cookie, cookieFile, out } = {}) {
  if (!host) throw new Error('session import-cookie 需要 --host <平台域名，如 soar.sea.sangfor.com>');
  // 超长 cookie 经命令行 --cookie 粘贴偶发单字符损坏（base64 token 翻一个字符→JWT 失效→403）。
  // --cookie-file 从文件读，绕开命令行/终端粘贴，避免长串被改坏。优先 file。
  if (cookieFile) cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  if (!cookie) throw new Error('session import-cookie 需要 --cookie "<整串>" 或 --cookie-file <文件>（DevTools→Network→请求头 Cookie 复制；长串建议用 --cookie-file 避免命令行粘贴损坏）');
  const cookies = cookie.split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((pair) => {
      const i = pair.indexOf('=');
      return {
        name: pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        domain: host, // 精确域；若登录态不生效可改 `.${host}`
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      };
    });
  if (!cookies.length) throw new Error('未解析到任何 cookie，检查 --cookie 串是否完整');

  const target = out || defaultStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ cookies, origins: [] }, null, 2)}\n`);
  fs.renameSync(tmp, target);
  readStorageState(target); // 校验可被适配器加载

  const hasCsrf = cookies.some((c) => c.name === 'csrf_token');
  return {
    imported: true,
    path: target,
    host,
    cookieCount: cookies.length,
    hasCsrf,
    warning: hasCsrf ? undefined : '未发现 csrf_token——发请求可能 403，确认 cookie 串含 httpOnly 项',
    next: [
      `export PLATFORM_COMMAND_USER_ID=local`,
      `export PLATFORM_COMMAND_STORAGE_STATE=${target}`,
      `node dist/src/entry/cli.js execute --command mss.export_weekly --execute-real --confirm companyId=<ID>`
    ]
  };
}

// 查看当前登录态是否就绪（导出类命令前自检）。
export function sessionStatus({ state } = {}) {
  const target = state || defaultStatePath();
  if (!fs.existsSync(target)) return { ready: false, path: target, reason: '文件不存在；用 session import-cookie / login 创建' };
  let parsed;
  try {
    parsed = readStorageState(target);
  } catch (err) {
    return { ready: false, path: target, reason: err.message };
  }
  const hosts = [...new Set((parsed.cookies || []).map((c) => c.domain))];
  return {
    ready: true,
    path: target,
    cookieCount: parsed.cookies.length,
    hosts,
    hasCsrf: parsed.cookies.some((c) => c.name === 'csrf_token'),
    envSet: Boolean(process.env.PLATFORM_COMMAND_STORAGE_STATE)
  };
}

// 打开 headed 浏览器让用户登录，保存 storageState（本地开发辅助；需 playwright）。
export async function loginAndSaveState({ url, out } = {}) {
  if (!url) throw new Error('session login 需要 --url <登录页地址>');
  const target = out || defaultStatePath();
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    throw new Error('session login 需要 playwright：npm i playwright && npx playwright install chromium');
  }
  const browser = await pw.chromium.launch(chromeLaunchOptions({ headless: false }));
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    process.stderr.write('请在浏览器中完成登录，然后回终端按 Enter 保存登录态...\n');
    await new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', () => resolve()); });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await context.storageState({ path: target });
    return { saved: true, path: target };
  } finally {
    await browser.close();
  }
}

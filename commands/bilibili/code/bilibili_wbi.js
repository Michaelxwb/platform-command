import crypto from 'node:crypto';
import path from 'node:path';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

export async function signQuery(query) {
  const keys = await fetchWbiKeys();
  return signBilibiliWbi(query, keys);
}

export function signBilibiliWbi(params, { imgKey, subKey }, now = Math.floor(Date.now() / 1000)) {
  const mixinKey = MIXIN_KEY_ENC_TAB.map((index) => `${imgKey}${subKey}`[index]).join('').slice(0, 32);
  const signed = { ...params, wts: now };
  const query = Object.keys(signed)
    .sort()
    .map((key) => {
      const value = String(signed[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return {
    ...signed,
    w_rid: crypto.createHash('md5').update(query + mixinKey).digest('hex')
  };
}

async function fetchWbiKeys() {
  const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.bilibili.com/',
      'user-agent': 'platform-command-command-code/0.3.0'
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching Bilibili WBI keys`);
  const nav = await response.json();
  const imgUrl = nav.data?.wbi_img?.img_url || '';
  const subUrl = nav.data?.wbi_img?.sub_url || '';
  const imgKey = path.basename(new URL(imgUrl).pathname, path.extname(new URL(imgUrl).pathname));
  const subKey = path.basename(new URL(subUrl).pathname, path.extname(new URL(subUrl).pathname));
  if (!imgKey || !subKey) throw new Error('Failed to fetch Bilibili WBI keys');
  return { imgKey, subKey };
}

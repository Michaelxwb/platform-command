// @ts-nocheck
// 导出语种版本构造（rewrite set builder）：英语固定存在，附加平台小语种（去重）。
// 复刻 background_export：export_locales = ["en"] 或 ["en", <locale>]。
export function buildValue(_unused, { context }) {
  const locale = String(context.params?.locale || '').trim();
  if (locale && locale !== 'en') return ['en', locale];
  return ['en'];
}

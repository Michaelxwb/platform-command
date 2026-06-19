// @ts-nocheck
// 同步 portal 请求体构造（body 变换钩子，复刻 do_sync_portal 的 report_version 逻辑）。
// report_version = 显式传入优先；否则 locale 非空且非 en → [locale,"en"]，否则 ["en"]。
export function buildBody(_body, { context }) {
  const p = context.params || {};
  let reportVersion = Array.isArray(p.reportVersion) && p.reportVersion.length ? p.reportVersion : null;
  if (!reportVersion) {
    const locale = String(p.locale || '').trim();
    reportVersion = locale && locale !== 'en' ? [locale, 'en'] : ['en'];
  }
  return {
    report_type: p.reportType,
    task_id: p.taskId,
    report_version: reportVersion
  };
}

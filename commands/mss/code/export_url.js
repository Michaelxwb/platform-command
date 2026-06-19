// @ts-nocheck
// 导出页 URL 构造（interceptFlow.urlBuilder）：按报告类型 + 配置范围算时间范围，拼导出 URL。
// 复刻 api.build_export_url + trigger_export 的时间范围逻辑。
import { calcDateRange } from './date_range.js';

const BASE = 'https://soar.sea.sangfor.com';

export function buildUrl(_unused, { context }) {
  const p = context.params || {};
  const { startTime, endTime } = calcDateRange(p.reportType, p.rangeType);
  const q = new URLSearchParams({
    mode: 'export',
    templateID: p.templateId,
    templateName: p.templateName,
    templateSecondName: '',
    companyID: p.companyId,
    startTime,
    endTime,
    generate_type: 'auto'
  });
  return `${p.baseUrl || BASE}/report_edit.html#/report-edit?${q.toString()}`;
}

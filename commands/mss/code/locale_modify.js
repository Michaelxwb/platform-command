// @ts-nocheck
// 改小语种的请求体构造（body 变换钩子，复刻 api._clean_logo_for_modify + module_list 兜底）。
// 后台固定 report_type=12；从前序 GET 步骤（context.steps.current）取 logo/module_list/channel_id，
// 清洗 logo、缺失 module_list 时用默认值兜底，再拼最终 MODIFY 请求体。
import fs from 'node:fs';

const REPORT_TYPE_WEEKLY = 12;

function cleanLogo(logo = {}) {
  const cl = logo.company_logo || {};
  const sl = logo.sangfor_logo || {};
  const ch = logo.channel_logo || {};
  return {
    company_logo: { is_show: cl.is_show ?? 1, file_id: cl.file_id ?? '' },
    sangfor_logo: { is_show: sl.is_show ?? 1, file_id: sl.file_id ?? '' },
    channel_logo: { is_show: ch.is_show ?? 1, is_font2img: ch.is_font2img ?? 1 }
  };
}

function defaultModuleList() {
  try {
    const url = new URL('../templates/default_weekly_module_list.json', import.meta.url);
    return JSON.parse(fs.readFileSync(url, 'utf8')).module_list || [];
  } catch {
    return [];
  }
}

// 小语种入参归一：印尼语/德语/泰语已由 agent 映射为 id/de/th；空/empty/"" 表示清空。
function normalizeLocale(locale) {
  if (locale === undefined || locale === null) return '';
  if (locale === '空' || locale === 'empty') return '';
  return String(locale);
}

export function buildBody(_body, { context }) {
  const current = context.steps?.current || {};
  const moduleList = Array.isArray(current.moduleList) && current.moduleList.length
    ? current.moduleList
    : defaultModuleList();
  return {
    company_id: context.params.companyId,
    channel_id: current.channelId || '',
    module_list: moduleList,
    report_type: REPORT_TYPE_WEEKLY,
    logo: cleanLogo(current.logo || {}),
    local_locale: normalizeLocale(context.params.locale)
  };
}

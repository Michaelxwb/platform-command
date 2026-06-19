// @ts-nocheck
// MSS 报告时间范围计算（命令包内 JS 逃生口，复刻 trigger_export.calc_date_range）。
// 纯函数：reportType('weekly'|'monthly') + rangeType + 可注入 today（测试用）→ {startTime,endTime}（YYYY-MM-DD）。

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function calcDateRange(reportType, rangeType, today = new Date()) {
  // 归一到当天 0 点，避免时区/时分干扰
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (reportType === 'monthly') {
    if (rangeType === 'Last 30 days') {
      const end = addDays(base, -1);             // 昨天
      const start = addDays(end, -29);           // 往前推 29 天
      return { startTime: fmt(start), endTime: fmt(end) };
    }
    // Last month（默认）：上个自然月
    const firstOfThisMonth = new Date(base.getFullYear(), base.getMonth(), 1);
    const lastMonthEnd = addDays(firstOfThisMonth, -1);
    const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
    return { startTime: fmt(lastMonthStart), endTime: fmt(lastMonthEnd) };
  }

  // weekly
  if (rangeType === 'Last week') {
    // 上周一到上周日（周一为一周起点）
    const dow = (base.getDay() + 6) % 7;         // 周一=0 ... 周日=6
    const lastMonday = addDays(base, -(dow + 7));
    const lastSunday = addDays(lastMonday, 6);
    return { startTime: fmt(lastMonday), endTime: fmt(lastSunday) };
  }
  // Last 7 days（默认）：昨天往前推 6 天
  const end = addDays(base, -1);
  const start = addDays(end, -6);
  return { startTime: fmt(start), endTime: fmt(end) };
}

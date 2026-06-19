// @ts-nocheck
// 发送报告邮件的请求体构造（body 变换钩子，复刻 send_email.do_send_email + resolve_emails）。
// 收件人 = 平台邮箱（前序步骤查询）+ 本地 added − removed（参数传入），可被显式 recipient/cc/bcc 覆盖。

const REPORT_ICON = {
  weekly: 'Weekly Security Report',
  monthly: 'Monthly Security Report'
};

function toEmailObjs(arr) {
  return (Array.isArray(arr) ? arr : []).map((addr) => ({ _id: addr, value: addr }));
}

// 从 actual_data 数组取邮箱地址：[{actual_data_value:{email_address}}]
function platformAddrs(step) {
  return ((step && step.list) || [])
    .map((it) => it && it.actual_data_value && it.actual_data_value.email_address)
    .filter(Boolean);
}

// 平台 + added − removed（去重保序），复刻 resolve_emails。
function resolveList(base, added, removed) {
  const merged = [];
  for (const a of [...base, ...(added || [])]) if (!merged.includes(a)) merged.push(a);
  const remove = new Set(removed || []);
  return merged.filter((a) => !remove.has(a));
}

export function buildBody(_body, { context }) {
  const s = context.steps || {};
  const p = context.params || {};
  const added = p.emailsAdded || {};
  const removed = p.emailsRemoved || {};

  // 显式传入（非空）优先；否则按 平台 + added − removed 解析。
  // 三者都用 .length 守卫：默认空数组不得当成"显式覆盖为空"而吞掉平台配置。
  const override = (v) => Array.isArray(v) && v.length;
  const recipient = override(p.recipient) ? p.recipient : resolveList(platformAddrs(s.platRecipient), added.recipient, removed.recipient);
  const cc = override(p.cc) ? p.cc : resolveList(platformAddrs(s.platCc), added.cc, removed.cc);
  const bcc = override(p.bcc) ? p.bcc : resolveList(platformAddrs(s.platBcc), added.bcc, removed.bcc);

  const accepter = toEmailObjs(recipient);
  if (!accepter.length) throw new Error('发送失败: 未配置收件人邮箱（平台 + added − removed 为空）');

  const attachmentIds = (s.attachments?.files || []).map((f) => f && f._id).filter(Boolean);

  return {
    company_name: { _id: p.companyId, value: s.companyName?.companyName || '', param_codes: 'mss_company_name' },
    accepter,
    ccer: toEmailObjs(cc),
    bccer: toEmailObjs(bcc),
    email_subject: s.subject?.subject || '',
    email_content: `${s.header?.header || ''}\n${s.push?.pushContent || ''}\n${s.sign?.sign || ' '}`,
    attachments: attachmentIds,
    attachment_icon: { _id: p.taskId, value: REPORT_ICON[p.reportType] || REPORT_ICON.weekly, param_codes: 'operate_report_type_all' },
    is_async: true,
    action_code: 'auto_send_email'
  };
}

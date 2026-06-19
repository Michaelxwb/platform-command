// @ts-nocheck
// display_config 读结果派生：复刻 skill _do_downstream 门控——report_check=true 时跳过全部自动下游。
// autoSend = send_email && !report_check；autoSync = sync_portal && !report_check。
export function derive(config = {}) {
  const reportCheck = !!config.report_check;
  return {
    autoSend: !reportCheck && !!config.send_email,
    autoSync: !reportCheck && !!config.sync_portal
  };
}

/**
 * Host 连续启动失败、main 停止重启时的错误对话框文案。这时页面连不上 Host，没法像未保存确认框那样由页面
 * 按当前语言传入文案，所以 main 按系统语言（app.getLocale()）在中文和英文之间选。
 */

export interface HostFailureText {
  message: string
  /** {count} 换成连续失败次数。 */
  detail: string
  /** 后面接 Host 报告的失败原因。 */
  reason: string
}

const ZH_CN: HostFailureText = {
  message: "Pigcode 的后台服务无法启动",
  detail: "已连续失败 {count} 次，不再自动重试。请退出后重新打开 Pigcode。",
  reason: "原因：",
}

const EN_US: HostFailureText = {
  message: "Pigcode's background service can't start",
  detail:
    "It failed {count} times in a row and won't be restarted. Quit and reopen Pigcode to try again.",
  reason: "Reason: ",
}

/** 按 locale 取文案：中文 locale 用中文，其余用英文。 */
export function hostFailureText(locale: string): HostFailureText {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

/** 对话框的正文：失败次数，加上 Host 报告的原因（有的话）。 */
export function hostFailureDetail(
  text: HostFailureText,
  count: number,
  reason: string | null,
): string {
  const detail = text.detail.replace("{count}", String(count))
  return reason ? `${detail}\n\n${text.reason}${reason}` : detail
}

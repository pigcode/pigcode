/** 退出确认框的文案：有任务在跑、等待审批或启用了定时任务时，退出前问一次（pigcode/pigcode#65）。 */
export interface QuitLabels {
  title: string
  /** 有这一类工作时追加一行；{count} 换成数量。 */
  runs: string
  approvals: string
  schedules: string
  quit: string
  stay: string
}

const ZH_CN: QuitLabels = {
  title: "还有工作在运行",
  runs: "{count} 个任务正在运行或排队，退出会中断它们。",
  approvals: "{count} 个请求在等待你的审批。",
  schedules: "{count} 个定时任务已启用，退出后不会触发。",
  quit: "退出",
  stay: "继续运行",
}

const EN_US: QuitLabels = {
  title: "Work is still running",
  runs: "{count} task(s) are running or queued and will be interrupted.",
  approvals: "{count} request(s) are waiting for your approval.",
  schedules: "{count} scheduled task(s) are enabled and won't run while Pigcode is closed.",
  quit: "Quit",
  stay: "Keep running",
}

export function quitLabels(locale: string): QuitLabels {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

/** 确认框的明细：只列出非零的项。 */
export function quitDetail(
  labels: QuitLabels,
  state: { runs: number; approvals: number; schedules: number },
): string[] {
  const lines: string[] = []
  if (state.runs > 0) lines.push(labels.runs.replace("{count}", String(state.runs)))
  if (state.approvals > 0) {
    lines.push(labels.approvals.replace("{count}", String(state.approvals)))
  }
  if (state.schedules > 0) {
    lines.push(labels.schedules.replace("{count}", String(state.schedules)))
  }
  return lines
}

/**
 * 退出前经 Host 的控制端口问一次还有多少工作（pigcode/pigcode#65）。
 * 单独放一个文件，是为了不依赖 Electron 也能测：端口只用到 on/off/postMessage。
 */
export interface QuitState {
  /** 运行中和排队中的 run。 */
  runs: number
  /** 等待用户处理的审批与提问。 */
  approvals: number
  /** 已启用的定时任务。 */
  schedules: number
}

/** 控制端口的最小接口。 */
export interface QuitStatePort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void
  off(event: "message", listener: (event: { data?: unknown }) => void): void
  postMessage(message: unknown): void
}

/** 有需要用户知道的工作；只有定时任务也算，退出后它们不会触发。 */
export function hasPendingWork(state: QuitState): boolean {
  return state.runs > 0 || state.approvals > 0 || state.schedules > 0
}

/** 读整数，坏数据当 0。 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** 问一次；Host 没应答（崩溃中、正在重启）时返回 null，调用方据此直接退出。 */
export function askQuitState(port: QuitStatePort, timeoutMs = 1000): Promise<QuitState | null> {
  return new Promise((resolve) => {
    const id = Date.now()
    let settled = false
    const done = (state: QuitState | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      port.off("message", listener)
      resolve(state)
    }
    const listener = (event: { data?: unknown }): void => {
      const data = event.data as { type?: string; id?: number; state?: unknown } | undefined
      if (data?.type !== "app.quit-state" || data.id !== id) return
      const state = data.state as Partial<QuitState> | undefined
      done({
        runs: count(state?.runs),
        approvals: count(state?.approvals),
        schedules: count(state?.schedules),
      })
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    try {
      port.on("message", listener)
      port.postMessage({ type: "app.quit-state", id })
    } catch {
      // 端口已经关掉（Host 刚崩溃）时不能再问，按没有工作处理，不能把退出卡住。
      done(null)
    }
  })
}

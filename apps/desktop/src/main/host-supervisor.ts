/**
 * 监管 Host utilityProcess：启动；退出后按 host-restart.ts 的策略退避重启；连续快速失败太多次时停下，
 * 交给 main 报错。开发时（dev-mode.ts）还负责换上新构建。
 */
import type { MessagePortMain } from "electron"
import { startHostProcess, type HostProcess } from "./host-process"
import { decideRestart, readHostFatal, type RestartDecision } from "./host-restart"

export interface HostSupervisorOptions {
  /** Host bundle 的路径。 */
  entry: string
  /** 用户 profile 目录；每次启动时取，app 改名以后才算得对。 */
  profileDir: () => string
  /** 应用正在退出：Host 退出后不再重启。 */
  quitting: () => boolean
  /** 每个新 Host 启动后调用，由 main 把端口交给浏览器面板和页面。 */
  onStart: (host: HostProcess) => void
  /** 连续快速失败太多次，不再重启；fatal 是 Host 最后报告的失败原因。 */
  onGiveUp: (failures: number, fatal: string | null) => void
  /** 测试用：替换真正的进程启动。 */
  spawn?: (entry: string, profileDir: string) => HostProcess
}

export interface HostSupervisor {
  /** 最近启动的 Host；放弃重启以后是 undefined。退避等待期间仍是已经退出的那个。 */
  readonly current: HostProcess | undefined
  /** 正在运行的 Host 的控制端口；Host 退出后是 undefined。 */
  readonly controlPort: MessagePortMain | undefined
  /** 启动 Host。 */
  start(): void
  /**
   * 换上新构建：停掉正在运行的 Host，它退出后立刻重启，不算一次失败。正在跑的 agent 和终端随旧 Host 结束。
   * Host 已经不在（退避等待中，或者已经放弃）时直接启动，改好代码就能接着试。
   */
  reload(): void
}

export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const spawn = options.spawn ?? startHostProcess
  let current: HostProcess | undefined
  /** 还没退出的 Host。 */
  let running: HostProcess | undefined
  /** 为了换上新构建而停掉的 Host。 */
  let reloading: HostProcess | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  /** 连续快速失败的次数与最近一次 Host 报告的失败原因。 */
  let quickFailures = 0
  let lastFatal: string | null = null

  function start(): void {
    const next = spawn(options.entry, options.profileDir())
    const startedAt = Date.now()
    current = next
    running = next
    next.child.on("message", (message: unknown) => {
      lastFatal = readHostFatal(message) ?? lastFatal
    })
    next.child.on("exit", () => {
      if (running === next) running = undefined
      if (options.quitting()) return
      const reloaded = reloading === next
      if (reloaded) reloading = undefined
      const decision: RestartDecision = reloaded
        ? { action: "restart", delayMs: 0, quickFailures: 0 }
        : decideRestart(quickFailures, Date.now() - startedAt)
      quickFailures = decision.quickFailures
      if (decision.quickFailures === 0) lastFatal = null
      if (decision.action === "give-up") {
        current = undefined
        options.onGiveUp(decision.quickFailures, lastFatal)
        return
      }
      restartTimer = setTimeout(() => {
        restartTimer = undefined
        if (!options.quitting()) start()
      }, decision.delayMs)
    })
    options.onStart(next)
  }

  function reload(): void {
    if (options.quitting() || reloading) return
    if (running) {
      reloading = running
      void running.stop()
      return
    }
    clearTimeout(restartTimer)
    restartTimer = undefined
    quickFailures = 0
    lastFatal = null
    start()
  }

  return {
    get current() {
      return current
    },
    get controlPort() {
      return running?.controlPort
    },
    start,
    reload,
  }
}

/** 应用更新状态由主进程持有，窗口与设置页共享。 */
export interface DesktopUpdateState {
  autoCheck: boolean
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "failed"
  currentVersion: string
  version: string | null
  url: string | null
  action: "download" | "restart" | "open-package" | "open-release" | null
  progress: number | null
  error: "check" | "download" | "open" | "install" | null
}

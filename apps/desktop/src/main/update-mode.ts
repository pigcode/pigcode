/**
 * 哪些安装包能自己装更新（pigcode/monorepo#71）。
 * macOS 的包没签名，electron-updater 装不了（ADR 0005）；deb 每次全量下载还要输系统密码，也不做。
 * 其余情况只提示去下载页。
 */
export type UpdateMode = "install" | "notify"

export function updateMode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): UpdateMode {
  if (platform === "win32") return "install"
  // AppImage 由 APPIMAGE 环境变量标识；同一个 Linux 安装包里的 deb 没有它。
  if (platform === "linux" && Boolean(env.APPIMAGE)) return "install"
  return "notify"
}

/** 能不能真的下载并安装：只有开发时跑不起来（electron-updater 读不到 app-update.yml）。 */
export function canInstallUpdates(mode: UpdateMode, isPackaged: boolean): boolean {
  return mode === "install" && isPackaged
}

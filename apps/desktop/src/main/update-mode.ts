/**
 * 发现新版本之后怎么处理（pigcode/monorepo#71）。
 *
 * - `install`：Windows 和 AppImage，electron-updater 后台下载，退出时装上。
 * - `replace`：macOS。包没签名，electron-updater 接不了（ADR 0005），但可以下载完整的
 *   DMG 再交给系统打开，用户把 Pigcode.app 拖进「应用程序」就完成升级。用户数据在
 *   `~/Library/Application Support/Pigcode`，换掉 .app 不会动它。
 * - `notify`：deb 等，只打开下载页。
 */
export type UpdateMode = "install" | "replace" | "notify"

export function updateMode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): UpdateMode {
  if (platform === "win32") return "install"
  // AppImage 由 APPIMAGE 环境变量标识；同一个 Linux 安装包里的 deb 没有它。
  if (platform === "linux" && Boolean(env.APPIMAGE)) return "install"
  if (platform === "darwin") return "replace"
  return "notify"
}

/** 能不能真的下载并安装：只有开发时跑不起来（electron-updater 读不到 app-update.yml）。 */
export function canInstallUpdates(mode: UpdateMode, isPackaged: boolean): boolean {
  return mode === "install" && isPackaged
}

/** 能不能下载完整包交给用户替换；同样只在打包后可用。 */
export function canReplaceApp(mode: UpdateMode, isPackaged: boolean): boolean {
  return mode === "replace" && isPackaged
}

/**
 * 关窗口以后应用怎么走（pigcode/monorepo#18）：macOS 和 Windows 隐藏到托盘继续运行，
 * Linux 直接退出——GNOME 默认不显示托盘图标，隐藏以后用户可能找不回窗口。
 */
export function hidesOnClose(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32"
}

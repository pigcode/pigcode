/** 托盘菜单和隐藏到托盘时的提示文案；和 Host 失败对话框一样按系统语言选中文或英文。 */
export interface TrayLabels {
  open: string
  quit: string
  /** 第一次隐藏到托盘时的系统通知。 */
  hiddenTitle: string
  hiddenBody: string
}

const ZH_CN: TrayLabels = {
  open: "打开窗口",
  quit: "退出 Pigcode",
  hiddenTitle: "Pigcode 还在运行",
  hiddenBody: "窗口已隐藏到托盘，任务会继续在后台运行。",
}

const EN_US: TrayLabels = {
  open: "Open Window",
  quit: "Quit Pigcode",
  hiddenTitle: "Pigcode is still running",
  hiddenBody: "The window is hidden in the tray; tasks keep running in the background.",
}

export function trayLabels(locale: string): TrayLabels {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

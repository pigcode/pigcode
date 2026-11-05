/** 发现新版本时的提示文案：下载页是 GitHub Release（ADR 0010）。 */
export interface UpdateLabels {
  title: string
  detail: string
  download: string
  later: string
  /** 已经下载好、等下次退出（或现在重启）时安装。 */
  readyTitle: string
  readyDetail: string
  restart: string
}

const ZH_CN: UpdateLabels = {
  title: "有新版本 {version}",
  detail: "打开下载页获取新版本。当前正在运行的任务不会受影响。",
  download: "打开下载页",
  later: "稍后",
  readyTitle: "新版本 {version} 已下载",
  readyDetail: "重启 Pigcode 完成安装。正在运行的任务会先按退出流程确认。",
  restart: "重启并更新",
}

const EN_US: UpdateLabels = {
  title: "Version {version} is available",
  detail: "Open the download page to get it. Running tasks are not affected.",
  download: "Open download page",
  later: "Later",
  readyTitle: "Version {version} is ready to install",
  readyDetail: "Restart Pigcode to finish. Running tasks are confirmed before it quits.",
  restart: "Restart and update",
}

export function updateLabels(locale: string): UpdateLabels {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

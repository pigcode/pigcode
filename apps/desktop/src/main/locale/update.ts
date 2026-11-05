/** 发现新版本时的提示文案：下载页是 GitHub Release（ADR 0010）。 */
export interface UpdateLabels {
  title: string
  detail: string
  download: string
  later: string
}

const ZH_CN: UpdateLabels = {
  title: "有新版本 {version}",
  detail: "打开下载页获取新版本。当前正在运行的任务不会受影响。",
  download: "打开下载页",
  later: "稍后",
}

const EN_US: UpdateLabels = {
  title: "Version {version} is available",
  detail: "Open the download page to get it. Running tasks are not affected.",
  download: "Open download page",
  later: "Later",
}

export function updateLabels(locale: string): UpdateLabels {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

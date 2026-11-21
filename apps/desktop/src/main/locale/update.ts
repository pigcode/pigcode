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
  /** macOS：完整包下载好了，打开它让用户把应用拖进「应用程序」。 */
  replaceTitle: string
  replaceDetail: string
  replace: string
  /** 下载完整包失败时补在下载页提示里的一句解释。 */
  downloadFailed: string
  /** 安装包下载好了但打不开。 */
  openFailed: string
}

const ZH_CN: UpdateLabels = {
  title: "有新版本 {version}",
  detail: "打开下载页就能拿到新版本。正在跑的任务不受影响。",
  download: "打开下载页",
  later: "稍后",
  readyTitle: "新版本 {version} 已下载",
  readyDetail: "重启 Pigcode 就装好了。有任务在跑时，退出前会先问你。",
  restart: "重启并更新",
  replaceTitle: "新版本 {version} 已下载",
  replaceDetail: "打开安装包，把 Pigcode 拖进「应用程序」换掉旧版本。你的会话、设置和插件都还在。",
  replace: "打开安装包",
  downloadFailed: "新版本没下载成功，帮你打开下载页",
  openFailed: "安装包打不开，帮你打开下载页",
}

const EN_US: UpdateLabels = {
  title: "Version {version} is available",
  detail: "Open the download page to get it. Running tasks are not affected.",
  download: "Open download page",
  later: "Later",
  readyTitle: "Version {version} is ready to install",
  readyDetail: "Restart Pigcode to finish. Running tasks are confirmed before it quits.",
  restart: "Restart and update",
  replaceTitle: "Version {version} is downloaded",
  replaceDetail:
    "Open the package and drag Pigcode into Applications to replace the old one. Your sessions, settings and plugins stay.",
  replace: "Open the package",
  downloadFailed: "The download failed, opening the download page instead.",
  openFailed: "The package could not be opened, opening the download page instead.",
}

export function updateLabels(locale: string): UpdateLabels {
  return locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US
}

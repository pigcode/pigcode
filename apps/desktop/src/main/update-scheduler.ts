/**
 * 自动检查更新的节拍（pigcode/monorepo#67）：启动后查一次，之后每隔一段时间查一次，
 * 同一个版本在一次运行里只提示一次。怎么提示、怎么打开下载页由调用方注入，方便单独测试。
 */
import { fetchLatestRelease, isNewer, type LatestRelease } from "./update-check"

/** 手动检查的结果，设置页直接显示。 */
export interface UpdateResult {
  status: "up-to-date" | "update-available" | "error"
  version?: string
  url?: string
}

export interface UpdateSchedulerDeps {
  /** 现在该查哪个地址（E2E 指向本地服务）。 */
  apiUrl: () => string
  /** 检查被整体禁用时返回 false（E2E）。 */
  enabled: () => boolean
  /** 用户偏好：自动检查是开还是关。 */
  autoCheck: () => boolean
  /** 用户偏好：接不接预发布版本。缺省按不接处理。 */
  allowPrerelease?: () => boolean
  /** 当前版本，用来比较。 */
  currentVersion: () => string
  /** 发现新版本时怎么提示；调用方只负责展示。 */
  prompt: (release: LatestRelease) => Promise<void>
  /** 自动检查失败只写日志，不打扰用户。 */
  log: (message: string) => void
  fetchRelease?: typeof fetchLatestRelease
  /** 每次检查完成都同步结果，手动和自动检查共用。 */
  onChecked?: (result: LatestRelease | null | "error") => void
}

export interface UpdateScheduler {
  /** 按当前偏好起停定时器；偏好变了就再调一次。 */
  start(): void
  stop(): void
  /** 手动检查：调用方负责显示结果。 */
  checkNow(): Promise<UpdateResult>
}

/** 启动后第一次检查的延迟，不和启动抢资源。 */
const STARTUP_DELAY_MS = 5000
/** 之后每 6 小时一次。 */
const INTERVAL_MS = 6 * 60 * 60 * 1000

export function createUpdateScheduler(deps: UpdateSchedulerDeps): UpdateScheduler {
  const fetchRelease = deps.fetchRelease ?? fetchLatestRelease
  let timer: NodeJS.Timeout | undefined
  let startup: NodeJS.Timeout | undefined
  /** 这次运行已经提示过的版本。 */
  let prompted: string | undefined
  let checking: Promise<LatestRelease | null | "error"> | null = null

  /** 查一次并判断有没有新版本。返回完整的 Release，附件要留给调用方挑安装包。 */
  const readUpdate = async (): Promise<LatestRelease | null | "error"> => {
    const release = await fetchRelease(deps.apiUrl(), undefined, undefined, {
      allowPrerelease: deps.allowPrerelease?.() ?? false,
    })
    // 取不到（断网、仓库还私有）算失败；不影响别的功能。
    if (!release) return "error"
    return isNewer(release.version, deps.currentVersion()) ? release : null
  }
  const findUpdate = (): Promise<LatestRelease | null | "error"> => {
    checking ??= readUpdate()
      .catch(() => "error" as const)
      .then((found) => {
        deps.onChecked?.(found)
        return found
      })
      .finally(() => {
        checking = null
      })
    return checking
  }

  const checkNow = async (): Promise<UpdateResult> => {
    const found = await findUpdate()
    if (found === "error") return { status: "error" }
    if (found === null) return { status: "up-to-date" }
    return { status: "update-available", version: found.version, url: found.url }
  }

  const run = async (): Promise<void> => {
    const found = await findUpdate()
    if (found === "error") {
      deps.log("update check failed")
      return
    }
    if (found === null) return
    if (found.version === prompted) return
    prompted = found.version
    // 整个 Release 传下去：macOS 换包要靠 assets 挑 DMG，不能只剩 version 和 url。
    await deps.prompt(found)
  }

  const stop = (): void => {
    clearInterval(timer)
    clearTimeout(startup)
    timer = undefined
    startup = undefined
  }

  return {
    start() {
      stop()
      if (!deps.enabled() || !deps.autoCheck()) return
      startup = setTimeout(() => void run(), STARTUP_DELAY_MS)
      timer = setInterval(() => void run(), INTERVAL_MS)
    },
    stop,
    checkNow,
  }
}

/**
 * 检查 GitHub Release 有没有新版本（pigcode/monorepo#67）。
 * v1.0 的下载页和更新源都是 pigcode/pigcode 的 Release（ADR 0010），所以只需要比版本号、给出链接。
 */
export interface LatestRelease {
  /** 发布标签去掉前缀 v 后的版本号，例如 1.0.0。 */
  version: string
  /** Release 页面地址，点提示里的按钮打开它。 */
  url: string
  /** Release 里的安装包；macOS 靠它直接下载 DMG。缺省表示这个来源没有附件。 */
  assets?: LatestAsset[]
}

/** Release 里附的一个文件。 */
export interface LatestAsset {
  name: string
  /** 直接下载地址（browser_download_url）。 */
  url: string
}

/** 默认的 GitHub API；E2E 用 PIGCODE_UPDATE_API 指向本地服务。 */
export const LATEST_RELEASE_API = "https://api.github.com/repos/pigcode/pigcode/releases/latest"

/**
 * 解析 `x.y.z` 或 `x.y.z-<预发布>`。返回三段数字加预发布标记（正式版为 null）。
 * 预发布内部的先后按 semver 比较：`beta.2` < `beta.10`，`beta` < `beta.1`。
 */
export function parseVersion(
  value: unknown,
): { parts: [number, number, number]; prerelease: string | null } | null {
  if (typeof value !== "string") return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  }
}

/** 按 semver 比较两个预发布标识；相等时返回 0。 */
function comparePrerelease(left: string, right: string): number {
  const a = left.split(".")
  const b = right.split(".")
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const two = b[index]
    // 字段少的一方更小：1.0.0-beta < 1.0.0-beta.1
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const oneNumeric = /^\d+$/.test(one)
    const twoNumeric = /^\d+$/.test(two)
    // 数字段比字母段小，数字段之间按数值比。
    if (oneNumeric && twoNumeric) return Number(one) < Number(two) ? -1 : 1
    if (oneNumeric) return -1
    if (twoNumeric) return 1
    return one < two ? -1 : 1
  }
  return 0
}

/**
 * latest 是否比 current 新。
 *
 * 正式版永远比同号的预发布大（`1.0.0` > `1.0.0-beta.2`），所以装 beta 的人
 * 一旦发了正式版就会收到它——这正是想要的：beta 阶段结束后大家回到正式线。
 */
export function isNewer(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next.parts[index] !== now.parts[index]) return next.parts[index]! > now.parts[index]!
  }
  if (next.prerelease === now.prerelease) return false
  if (next.prerelease === null) return true
  if (now.prerelease === null) return false
  return comparePrerelease(next.prerelease, now.prerelease) > 0
}

/**
 * 从 GitHub 的 release 响应里取版本和链接。
 *
 * 草稿永远不算。预发布只在 `allowPrerelease` 时才收——调用方用用户的
 * 「接收预发布版本」偏好决定；关掉时正式版用户不会被推到 beta 上。
 */
export function readLatestRelease(
  json: unknown,
  options: { allowPrerelease?: boolean } = {},
): LatestRelease | null {
  if (typeof json !== "object" || json === null) return null
  const record = json as Record<string, unknown>
  if (record.draft === true) return null
  if (record.prerelease === true && options.allowPrerelease !== true) return null
  const version = parseVersion(record.tag_name)
  const url = record.html_url
  if (!version || typeof url !== "string" || !/^https:\/\//.test(url)) return null
  // 原样用 tag 里的版本号（去掉 v），保留 -beta.n 后缀，界面才能显示完整版本。
  const text = String(record.tag_name).trim().replace(/^v/, "")
  return { version: text, url, assets: readAssets(record.assets) }
}

/**
 * 安装包的下载地址。GitHub 给的永远是 https；明文只放行本机回环，
 * 这样 E2E 能在 localhost 上假造一次下载，而不会让远程的 http 地址进到下载器里。
 */
function isAssetUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol === "https:") return true
  return parsed.protocol === "http:" && isLoopback(parsed.hostname)
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

/** Release 附带的文件；残缺的条目直接跳过，坏数据不影响升级检查本身。 */
function readAssets(value: unknown): LatestAsset[] {
  if (!Array.isArray(value)) return []
  const assets: LatestAsset[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const item = entry as Record<string, unknown>
    const name = item.name
    const url = item.browser_download_url
    if (typeof name !== "string" || typeof url !== "string") continue
    if (!isAssetUrl(url)) continue
    assets.push({ name, url })
  }
  return assets
}

/**
 * 列出最近的 Release，按发布时间从新到旧。用列表而不是 `/releases/latest`：
 * 后者按 GitHub 的定义永远不返回预发布，开了「接收预发布」也拿不到 beta。
 */
export const RELEASES_API = "https://api.github.com/repos/pigcode/pigcode/releases?per_page=20"

/**
 * 从列表里挑出该用的那一个：草稿永远跳过；关掉预发布时也跳过 beta。
 * 列表已经按时间倒序，第一个符合条件的就是最新的。
 */
export function pickRelease(
  json: unknown,
  options: { allowPrerelease?: boolean } = {},
): LatestRelease | null {
  if (!Array.isArray(json)) return null
  for (const entry of json) {
    const release = readLatestRelease(entry, options)
    if (release) return release
  }
  return null
}
export async function fetchLatestRelease(
  apiUrl: string = RELEASES_API,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
  options: { allowPrerelease?: boolean } = {},
): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(apiUrl, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    })
    if (!response.ok) return null
    return pickRelease(await response.json(), options)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

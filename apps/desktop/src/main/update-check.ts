/**
 * 检查 GitHub Release 有没有新版本（pigcode/pigcode#67）。
 * v1.0 的下载页和更新源都是 pigcode/frontend 的 Release（ADR 0010），所以只需要比版本号、给出链接。
 */
export interface LatestRelease {
  /** 发布标签去掉前缀 v 后的版本号，例如 1.0.0。 */
  version: string
  /** Release 页面地址，点提示里的按钮打开它。 */
  url: string
}

/** 默认的 GitHub API；E2E 用 PIGCODE_UPDATE_API 指向本地服务。 */
export const LATEST_RELEASE_API = "https://api.github.com/repos/pigcode/frontend/releases/latest"

/** 解析 x.y.z；带预发布后缀或格式不对时返回 null。 */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** latest 是否比 current 新；任一版本解析不了时按没有新版本处理。 */
export function isNewer(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return next[index]! > now[index]!
  }
  return false
}

/** 从 GitHub 的 release 响应里取版本和链接；草稿和预发布不算。 */
export function readLatestRelease(json: unknown): LatestRelease | null {
  if (typeof json !== "object" || json === null) return null
  const record = json as Record<string, unknown>
  if (record.draft === true || record.prerelease === true) return null
  const version = parseVersion(record.tag_name)
  const url = record.html_url
  if (!version || typeof url !== "string" || !/^https:\/\//.test(url)) return null
  return { version: version.join("."), url }
}

/** 查询最新版本；网络错误、超时、404（仓库还私有）都返回 null。 */
export async function fetchLatestRelease(
  apiUrl: string = LATEST_RELEASE_API,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<LatestRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(apiUrl, {
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json" },
    })
    if (!response.ok) return null
    return readLatestRelease(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

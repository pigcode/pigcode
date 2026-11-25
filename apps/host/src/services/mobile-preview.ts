/**
 * 手机本机预览设置与桌面预览窗口地址同步服务（`ctx.mobilePreview`）。
 * 持久化 `mobile.preview.enabled`（未配置时默认开启），并通过控制端口接收 Electron 窗口打开的合法 loopback URL。
 */
import {
  MOBILE_PREVIEW_MAX_DESKTOP_URLS,
  MOBILE_PREVIEW_URL_MAX,
  desktopPreviewUrlsMessageSchema,
  mobilePreviewSettingsSchema,
  type MobilePreviewSettings,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { ControlPortLike } from "./browser"

export const MOBILE_PREVIEW_ENABLED_SETTING = "mobile.preview.enabled"

/** 允许访问的本机回环主机名白名单（严格字面量匹配，禁止任意数字/八进制/变形 IP）。 */
export const MOBILE_PREVIEW_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
])

/** 禁止通过预览隧道探测的常见非 HTTP 基础服务端口。 */
export const MOBILE_PREVIEW_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  22, 23, 25, 53, 110, 143, 445, 587, 993, 995, 1433, 1521, 3306, 3389, 5432, 6379, 9200, 11211,
  27017,
])

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/
const SCHEME_AUTHORITY_PATTERN = /^(https?):\/\/([^/?#\\]*)(?:[/?#]|$)/i
const IPV6_LOOPBACK_AUTHORITY_PATTERN = /^(\[::1\])(?::([1-9]\d{0,4}))?$/i
const HOST_PORT_AUTHORITY_PATTERN = /^([^:]+)(?::([1-9]\d{0,4}))?$/

/**
 * 严格校验并解析允许手机端本机预览的 loopback HTTP/HTTPS URL。
 * 先校验原始 authority 字面量以阻止 WHATWG URL 对十进制/八进制/十六进制/缩写 IP 的自动折叠，再双重校验解析结果与端口黑名单。
 */
export function parseAllowedMobilePreviewUrl(rawUrl: string): URL | null {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > MOBILE_PREVIEW_URL_MAX ||
    CONTROL_CHAR_PATTERN.test(rawUrl)
  ) {
    return null
  }
  const match = SCHEME_AUTHORITY_PATTERN.exec(rawUrl)
  if (!match) return null
  const authority = match[2] ?? ""
  if (authority.length === 0 || authority.includes("@")) return null

  let rawHost: string
  let rawPort: string | undefined
  if (authority.startsWith("[")) {
    const ipv6Match = IPV6_LOOPBACK_AUTHORITY_PATTERN.exec(authority)
    if (!ipv6Match) return null
    rawHost = ipv6Match[1]!.toLowerCase()
    rawPort = ipv6Match[2]
  } else {
    const hostMatch = HOST_PORT_AUTHORITY_PATTERN.exec(authority)
    if (!hostMatch) return null
    rawHost = hostMatch[1]!.toLowerCase()
    rawPort = hostMatch[2]
  }

  if (!MOBILE_PREVIEW_ALLOWED_HOSTS.has(rawHost)) return null
  if (rawPort !== undefined) {
    const explicitPort = Number(rawPort)
    if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) return null
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.username !== "" || parsed.password !== "") return null
  if (!MOBILE_PREVIEW_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null

  const effectivePort =
    parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80
  if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) return null
  if (MOBILE_PREVIEW_BLOCKED_PORTS.has(effectivePort)) return null

  return parsed
}

function messageData(value: unknown): unknown {
  return typeof value === "object" && value !== null && "data" in value
    ? (value as { data: unknown }).data
    : value
}

export interface MobilePreviewService {
  isEnabled(): boolean
  setEnabled(enabled: boolean): MobilePreviewSettings
  desktopUrls(): string[]
  setDesktopUrls(urls: readonly string[]): string[]
  getSettings(): MobilePreviewSettings
  attach(port: ControlPortLike): void
}

declare module "cordis" {
  interface Context {
    mobilePreview: MobilePreviewService
  }
}

export const inject = ["settings"]

export interface MobilePreviewPlugin {
  (ctx: Context): void
  inject: string[]
}

/** 注册手机本机预览设置与桌面预览地址同步服务。 */
export const apply: MobilePreviewPlugin = Object.assign(
  function apply(ctx: Context): void {
    let activeDesktopUrls: string[] = []

    const isEnabled = (): boolean => ctx.settings.get(MOBILE_PREVIEW_ENABLED_SETTING) !== false

    const getSettings = (): MobilePreviewSettings =>
      mobilePreviewSettingsSchema.parse({
        enabled: isEnabled(),
        desktopUrls: [...activeDesktopUrls],
      })

    const setDesktopUrls = (urls: readonly string[]): string[] => {
      const seen = new Set<string>()
      const next: string[] = []
      for (const candidate of urls) {
        if (next.length >= MOBILE_PREVIEW_MAX_DESKTOP_URLS) break
        const parsed = parseAllowedMobilePreviewUrl(candidate)
        if (!parsed) continue
        const normalized = parsed.toString()
        if (seen.has(normalized)) continue
        seen.add(normalized)
        next.push(normalized)
      }
      activeDesktopUrls = next
      return [...activeDesktopUrls]
    }

    const service: MobilePreviewService = {
      isEnabled,
      setEnabled(enabled) {
        ctx.settings.set(MOBILE_PREVIEW_ENABLED_SETTING, Boolean(enabled))
        return getSettings()
      },
      desktopUrls: () => [...activeDesktopUrls],
      setDesktopUrls,
      getSettings,
      attach(port) {
        port.start?.()
        port.on("message", (event) => {
          const parsed = desktopPreviewUrlsMessageSchema.safeParse(messageData(event))
          if (!parsed.success) return
          setDesktopUrls(parsed.data.urls)
        })
      },
    }

    ctx.provide("mobilePreview", service)
    ctx.effect(() => () => {
      activeDesktopUrls = []
    })
  },
  { inject },
)

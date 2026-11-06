/**
 * 应用自己的偏好，存在 userData/preferences.json。
 * 没有放进 Host 的设置：主进程在启动时就要用（开机自启、Dock 图标），等不到页面连上 Host。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface Preferences {
  /** 开机自动启动。默认关：应用不该没问过用户就自己常驻。 */
  launchAtLogin: boolean
  /** 在 Dock 中显示；关掉以后只能从菜单栏图标打开窗口。只在 macOS 上有意义。 */
  showInDock: boolean
  /** 自动检查更新。默认开；关掉以后还能在设置页手动检查。 */
  autoCheckUpdates: boolean
  /**
   * 接收预发布版本（x.y.z-beta.n）。默认关：beta 是给试用新功能的人准备的，
   * 正式版用户不该被推过去。开着时既能收到 beta 也能收到新的正式版。
   */
  prereleaseUpdates: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  launchAtLogin: false,
  showInDock: true,
  autoCheckUpdates: true,
  prereleaseUpdates: false,
}

/** 可以改的键；页面传其他键时忽略。 */
const KEYS = ["launchAtLogin", "showInDock", "autoCheckUpdates", "prereleaseUpdates"] as const
export type PreferenceKey = (typeof KEYS)[number]

export function isPreferenceKey(value: unknown): value is PreferenceKey {
  return typeof value === "string" && (KEYS as readonly string[]).includes(value)
}

/** 读偏好；文件不存在或读不懂时用默认值，坏掉的一个字段也只回到默认值。 */
export function readPreferences(path: string): Preferences {
  let stored: unknown
  try {
    stored = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
  const record =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {}
  const prefs = { ...DEFAULT_PREFERENCES }
  for (const key of KEYS) {
    const value = record[key]
    if (typeof value === "boolean") prefs[key] = value
  }
  return prefs
}

/** 改一个键；键或值不合法时原样返回。 */
export function withPreference(current: Preferences, key: unknown, value: unknown): Preferences {
  if (!isPreferenceKey(key) || typeof value !== "boolean") return current
  return { ...current, [key]: value }
}

export function writePreferences(path: string, prefs: Preferences): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8")
}

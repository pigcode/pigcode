// 负责外观设置的数据模型、默认值、读写校验和不可变更新；不碰 DOM 和存储。
import type { Hex } from "./color-math"
import { parseHex } from "./color-math"
import { parseThemeColors } from "./theme-file"
import type { ThemeDefinition } from "./theme-presets"
import type { ThemePreference } from "./theme-model"
import { parseThemePreference } from "./theme-model"

/** 对 bg、fg、accent 的单项覆盖。 */
export type ColorOverride = Partial<Record<"bg" | "fg" | "accent", Hex>>

/** 某个主题在浅色、深色下各自的颜色修改。 */
export type ModeOverrides = Partial<Record<"light" | "dark", ColorOverride>>

/** 一个模式使用的主题、强调色方式和界面字体。 */
export type ThemeSlot = {
  themeId: string
  accentMode: "default" | "custom"
  uiFont: "system" | "inter" | "source-han"
}

/** 全部外观设置，带版本号。 */
export type AppearanceSettings = {
  version: 1
  mode: ThemePreference
  splitModes: boolean
  light: ThemeSlot
  dark: ThemeSlot
  overrides: Record<string, ModeOverrides>
  glass: number
  contrast: number
  uiSize: number
  contentSize: number
  codeSize: number
  motion: "system" | "on" | "off"
  uiWeight: "regular" | "medium"
  contentFont: "same" | "serif" | "rounded"
  contentWeight: "regular" | "medium"
  codeFont: "system" | "jetbrains" | "fira" | "menlo"
  codeWeight: "regular" | "medium"
  smartPunctuation: boolean
  fullWidth: boolean
  diffMarker: "color" | "sign"
  pointerCursor: boolean
  dockIcon: "classic" | "pink" | "night"
  fontSmoothing: boolean
  advancedOpen: boolean
}

const defaultSlot: ThemeSlot = { themeId: "pigcode", accentMode: "default", uiFont: "system" }

/** 默认外观设置：与引入外观设置前的界面一致。 */
export const defaultAppearance: AppearanceSettings = {
  version: 1,
  mode: "system",
  splitModes: false,
  light: defaultSlot,
  dark: defaultSlot,
  overrides: {},
  glass: 60,
  contrast: 45,
  uiSize: 13,
  contentSize: 13.5,
  codeSize: 11.5,
  motion: "system",
  uiWeight: "regular",
  contentFont: "same",
  contentWeight: "regular",
  codeFont: "system",
  codeWeight: "regular",
  smartPunctuation: true,
  fullWidth: false,
  diffMarker: "color",
  pointerCursor: false,
  dockIcon: "classic",
  fontSmoothing: true,
  advancedOpen: false,
}

type Obj = Record<string, unknown>

function isRecord(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback: number, min: number, max: number, step: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const clamped = Math.min(max, Math.max(min, value))
  return Math.min(max, Math.max(min, Math.round(clamped / step) * step))
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function parseSlot(value: unknown): ThemeSlot {
  if (!isRecord(value)) return defaultSlot
  return {
    themeId:
      typeof value.themeId === "string" && value.themeId ? value.themeId : defaultSlot.themeId,
    accentMode: pick(value.accentMode, ["default", "custom"], defaultSlot.accentMode),
    uiFont: pick(value.uiFont, ["system", "inter", "source-han"], defaultSlot.uiFont),
  }
}

function parseColorOverride(value: unknown): ColorOverride | undefined {
  if (!isRecord(value)) return undefined
  const result: ColorOverride = {}
  for (const key of ["bg", "fg", "accent"] as const) {
    const raw = value[key]
    const hex = typeof raw === "string" ? parseHex(raw) : null
    if (hex) result[key] = hex
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseOverrides(value: unknown): Record<string, ModeOverrides> {
  const result: Record<string, ModeOverrides> = {}
  if (!isRecord(value)) return result
  for (const [themeId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    const light = parseColorOverride(entry.light)
    const dark = parseColorOverride(entry.dark)
    if (light || dark) result[themeId] = { ...(light ? { light } : {}), ...(dark ? { dark } : {}) }
  }
  return result
}

function fromObject(o: Obj): AppearanceSettings {
  const d = defaultAppearance
  return {
    version: 1,
    mode:
      o.mode === undefined
        ? d.mode
        : parseThemePreference(typeof o.mode === "string" ? o.mode : null),
    splitModes: bool(o.splitModes, d.splitModes),
    light: parseSlot(o.light),
    dark: parseSlot(o.dark),
    overrides: parseOverrides(o.overrides),
    glass: num(o.glass, d.glass, 0, 100, 1),
    contrast: num(o.contrast, d.contrast, 0, 100, 1),
    uiSize: num(o.uiSize, d.uiSize, 11, 18, 0.5),
    contentSize: num(o.contentSize, d.contentSize, 11, 20, 0.5),
    codeSize: num(o.codeSize, d.codeSize, 10, 18, 0.5),
    motion: pick(o.motion, ["system", "on", "off"], d.motion),
    uiWeight: pick(o.uiWeight, ["regular", "medium"], d.uiWeight),
    contentFont: pick(o.contentFont, ["same", "serif", "rounded"], d.contentFont),
    contentWeight: pick(o.contentWeight, ["regular", "medium"], d.contentWeight),
    codeFont: pick(o.codeFont, ["system", "jetbrains", "fira", "menlo"], d.codeFont),
    codeWeight: pick(o.codeWeight, ["regular", "medium"], d.codeWeight),
    smartPunctuation: bool(o.smartPunctuation, d.smartPunctuation),
    fullWidth: bool(o.fullWidth, d.fullWidth),
    diffMarker: pick(o.diffMarker, ["color", "sign"], d.diffMarker),
    pointerCursor: bool(o.pointerCursor, d.pointerCursor),
    dockIcon: pick(o.dockIcon, ["classic", "pink", "night"], d.dockIcon),
    fontSmoothing: bool(o.fontSmoothing, d.fontSmoothing),
    advancedOpen: bool(o.advancedOpen, d.advancedOpen),
  }
}

/** 解析保存的外观设置文本：每个字段单独校验，坏字段用默认值；JSON 损坏或 version 未知时返回 null。 */
export function parseStoredAppearance(raw: string): AppearanceSettings | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data) || data.version !== 1) return null
  return fromObject(data)
}

/**
 * 从本机保存的文本还原外观设置：每个字段单独校验，坏字段用默认值；
 * 新数据读不到（没有、损坏或 version 未知）时，有旧主题键就只迁移 mode，否则返回默认值。
 */
export function parseAppearance(
  raw: string | null,
  legacyTheme: string | null,
): AppearanceSettings {
  const stored = raw === null ? null : parseStoredAppearance(raw)
  if (stored !== null) return stored
  return legacyTheme === null
    ? defaultAppearance
    : { ...defaultAppearance, mode: parseThemePreference(legacyTheme) }
}

/** 把外观设置输出成可存入 localStorage 的 JSON 文本。 */
export function serializeAppearance(settings: AppearanceSettings): string {
  return JSON.stringify(settings)
}

/** 读出「我的主题」：跳过非法项和重复 id，坏数据返回空数组；结果的 builtIn 恒为 false。 */
export function parseCustomThemes(raw: string | null): ThemeDefinition[] {
  if (raw === null) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const themes: ThemeDefinition[] = []
  for (const item of data as unknown[]) {
    if (!isRecord(item)) continue
    const { id, name } = item
    if (typeof id !== "string" || !id || typeof name !== "string" || !name.trim()) continue
    const light = parseThemeColors(item.light)
    const dark = parseThemeColors(item.dark)
    if (!light || !dark || themes.some((theme) => theme.id === id)) continue
    themes.push({ id, name, builtIn: false, light, dark })
  }
  return themes
}

/** 当前实际显示的模式用哪个主题槽：不分别设置时始终是 light 槽。 */
export function activeSlot(settings: AppearanceSettings, resolved: "light" | "dark"): ThemeSlot {
  return settings.splitModes ? settings[resolved] : settings.light
}

/** 写入或清除（value 为 null）当前主题在 resolved 模式下的一个颜色修改，不改动另一个模式。 */
export function setOverride(
  settings: AppearanceSettings,
  resolved: "light" | "dark",
  key: "bg" | "fg" | "accent",
  value: Hex | null,
): AppearanceSettings {
  const { themeId } = activeSlot(settings, resolved)
  const entry = settings.overrides[themeId] ?? {}
  const color: ColorOverride = { ...entry[resolved] }
  if (value === null) delete color[key]
  else color[key] = value
  const nextEntry: ModeOverrides = { ...entry }
  if (Object.keys(color).length > 0) nextEntry[resolved] = color
  else delete nextEntry[resolved]
  const overrides = { ...settings.overrides }
  if (Object.keys(nextEntry).length > 0) overrides[themeId] = nextEntry
  else delete overrides[themeId]
  return { ...settings, overrides }
}

/** 回到默认设置，只保留高级区的展开状态。 */
export function resetAppearance(settings: AppearanceSettings): AppearanceSettings {
  return { ...defaultAppearance, overrides: {}, advancedOpen: settings.advancedOpen }
}

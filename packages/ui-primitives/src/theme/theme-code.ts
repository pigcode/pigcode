// 负责「主题代码」：把一个模式的外观写成一行可复制、可编辑、可粘贴的文本，以及把这样的文本应用回外观设置。
// 格式仿照 Codex 的 codex-theme-v1，也能直接读 Codex 的主题串；不碰 DOM 和存储。
import type { MessageKey } from "../locale/locale"
import { defaultTokens, tokenPaint } from "./appearance-glass"
import type {
  AppearanceSettings,
  CodeFontPreset,
  ColorKey,
  ColorOverride,
  UiFontPreset,
} from "./appearance-settings"
import { activeSlot, cleanFontName, colorKeys, editSlot, setUiFont } from "./appearance-settings"
import type { Hex } from "./color-math"
import { parseHex } from "./color-math"
import type { ThemeDefinition } from "./theme-presets"
import { builtInThemes, findTheme } from "./theme-presets"

/** pigcode 主题代码的前缀。 */
export const themeCodePrefix = "pigcode-theme-v1:"

/** 也认 Codex 的主题串。 */
const codexPrefix = "codex-theme-v1:"

type Mode = "light" | "dark"

/** 主题代码解出来的内容：fonts 里缺的项表示不改，null 表示系统默认。 */
export type ThemeCode = {
  themeId: string | null
  variant: Mode | null
  colors: ColorOverride
  contrast: number | null
  fonts: { ui?: string; code?: string }
}

/** 解析结果：失败时带文案 key，由界面按当前语言显示。 */
export type ThemeCodeResult = { ok: true; code: ThemeCode } | { ok: false; reason: MessageKey }

// 主题代码里颜色的字段名：和 Codex 一致，背景叫 surface，前景叫 ink，diff 颜色放在 semanticColors 里
const topLevel: Record<"accent" | "bg" | "fg", string> = {
  accent: "accent",
  bg: "surface",
  fg: "ink",
}

// 预设字体在主题代码里写成字体名，读回来时再认回预设
const uiFontNames: Record<Exclude<UiFontPreset, "system">, string> = {
  inter: "Inter",
  "source-han": "Source Han Sans SC",
}
const codeFontNames: Record<Exclude<CodeFontPreset, "system">, string> = {
  jetbrains: "JetBrains Mono",
  fira: "Fira Code",
  menlo: "Menlo",
}

function fontToName(value: string, names: Record<string, string>): string | null {
  if (value === "system") return null
  return Object.hasOwn(names, value) ? (names[value] ?? value) : value
}

function fontFromName(name: string | null, names: Record<string, string>): string {
  if (name === null) return "system"
  const preset = Object.entries(names).find(
    ([, label]) => label.toLowerCase() === name.toLowerCase(),
  )
  return preset ? preset[0] : name
}

/** 字体设置在界面和主题代码里显示的名字；系统默认是空串。 */
export function fontDisplayName(kind: "ui" | "code", value: string): string {
  return fontToName(value, kind === "ui" ? uiFontNames : codeFontNames) ?? ""
}

/** 把用户填的字体名换回字体设置：空白是系统默认，预设的名字认回预设 id。 */
export function fontFromDisplayName(kind: "ui" | "code", name: string): string {
  return fontFromName(cleanFontName(name), kind === "ui" ? uiFontNames : codeFontNames)
}

/** 预设字体的名字，给字体输入框做候选。 */
export function presetFontNames(kind: "ui" | "code"): string[] {
  return Object.values(kind === "ui" ? uiFontNames : codeFontNames)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// tokens.css 里各颜色的默认值（pigcode 主题、没有修改时实际显示的颜色）
const tokenNames: Record<ColorKey, string> = {
  accent: "--primary",
  bg: "--bg",
  fg: "--fg",
  diffAdded: "--diff-add-fg",
  diffRemoved: "--diff-remove-fg",
}

const tokenColorCache: Partial<Record<Mode, Record<ColorKey, Hex>>> = {}

/** tokens.css 里某个模式下各颜色的近似 `#RRGGBB`，给颜色框和主题小窗用；tokens.css 不会变，算一次就缓存。 */
export function tokenColors(mode: Mode): Record<ColorKey, Hex> {
  const cached = tokenColorCache[mode]
  if (cached) return cached
  const result = {} as Record<ColorKey, Hex>
  for (const key of colorKeys) result[key] = tokenPaint(defaultTokens[mode](tokenNames[key])).color
  tokenColorCache[mode] = result
  return result
}

/**
 * 某个模式下用户或主题明确给出的颜色（主题自带的加上用户修改的）；没有给出的项不在结果里，
 * 显示时沿用 tokens.css。强调色在「主题默认」方式下忽略用户修改，与界面实际效果一致。
 */
export function explicitColors(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  mode: Mode,
): ColorOverride {
  const slot = activeSlot(settings, mode)
  const theme = findTheme(slot.themeId, custom)
  const changed = settings.overrides[theme.id]?.[mode] ?? {}
  const base = theme[mode]
  const result: ColorOverride = { ...(base ?? {}) }
  for (const key of colorKeys) {
    if (key === "accent" && slot.accentMode !== "custom") continue
    const value = changed[key]
    if (value) result[key] = value
  }
  return result
}

/**
 * 某个模式下实际显示的五种颜色：tokens.css 的默认值盖上主题与用户明确给出的颜色。
 * pigcode 的颜色来自 tokens.css 的 oklch，这里是近似的 `#RRGGBB`。
 */
export function effectiveColors(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  mode: Mode,
): Record<ColorKey, Hex> {
  return { ...tokenColors(mode), ...explicitColors(settings, custom, mode) }
}

/** 把某个模式的外观写成一行主题代码：主题、全部五种颜色、对比度和两种字体。 */
export function encodeThemeCode(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  mode: Mode,
): string {
  const slot = activeSlot(settings, mode)
  const colors = effectiveColors(settings, custom, mode)
  const theme: Record<string, unknown> = {}
  for (const key of ["accent", "bg", "fg"] as const) {
    if (colors[key]) theme[topLevel[key]] = colors[key]
  }
  theme.contrast = settings.contrast
  theme.fonts = {
    ui: fontToName(slot.uiFont, uiFontNames),
    code: fontToName(settings.codeFont, codeFontNames),
  }
  const semantic: Record<string, Hex> = {}
  if (colors.diffAdded) semantic.diffAdded = colors.diffAdded
  if (colors.diffRemoved) semantic.diffRemoved = colors.diffRemoved
  if (Object.keys(semantic).length > 0) theme.semanticColors = semantic
  const themeId = findTheme(slot.themeId, custom).id
  return `${themeCodePrefix}${JSON.stringify({ themeId, variant: mode, theme })}`
}

function readColor(source: Record<string, unknown>, field: string): Hex | undefined {
  const raw = source[field]
  return typeof raw === "string" ? (parseHex(raw.trim()) ?? undefined) : undefined
}

function readFont(fonts: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in fonts)) return undefined
  const raw = fonts[field]
  if (raw === null) return null
  return typeof raw === "string" ? (cleanFontName(raw) ?? null) : undefined
}

/**
 * 解析主题代码：接受 `pigcode-theme-v1:`、`codex-theme-v1:` 前缀或不带前缀的 JSON。
 * 非法颜色和字体逐项丢弃；什么都读不出来时失败。
 */
export function decodeThemeCode(text: string): ThemeCodeResult {
  let body = text.trim()
  if (!body) return { ok: false, reason: "settings.appearance.code.empty" }
  for (const prefix of [themeCodePrefix, codexPrefix]) {
    if (body.startsWith(prefix)) body = body.slice(prefix.length).trim()
  }
  if (!body.startsWith("{")) return { ok: false, reason: "settings.appearance.code.notCode" }
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return { ok: false, reason: "settings.appearance.code.invalidJson" }
  }
  if (!isRecord(data) || !isRecord(data.theme)) {
    return { ok: false, reason: "settings.appearance.code.notCode" }
  }
  const source = data.theme
  const colors: ColorOverride = {}
  for (const key of ["accent", "bg", "fg"] as const) {
    const value = readColor(source, topLevel[key])
    if (value) colors[key] = value
  }
  if (isRecord(source.semanticColors)) {
    const diffAdded = readColor(source.semanticColors, "diffAdded")
    const diffRemoved = readColor(source.semanticColors, "diffRemoved")
    if (diffAdded) colors.diffAdded = diffAdded
    if (diffRemoved) colors.diffRemoved = diffRemoved
  }
  const fonts: ThemeCode["fonts"] = {}
  if (isRecord(source.fonts)) {
    const ui = readFont(source.fonts, "ui")
    const code = readFont(source.fonts, "code")
    if (ui !== undefined) fonts.ui = fontFromName(ui, uiFontNames)
    if (code !== undefined) fonts.code = fontFromName(code, codeFontNames)
  }
  const contrast =
    typeof source.contrast === "number" && Number.isFinite(source.contrast)
      ? Math.round(Math.min(100, Math.max(0, source.contrast)))
      : null
  // Codex 的 codeThemeId 是它自己的主题 id，和 pigcode 的预设重名时才有意义
  const rawId = typeof data.themeId === "string" ? data.themeId : data.codeThemeId
  const themeId = typeof rawId === "string" && rawId ? rawId : null
  const variant = data.variant === "light" || data.variant === "dark" ? data.variant : null
  const empty =
    Object.keys(colors).length === 0 &&
    Object.keys(fonts).length === 0 &&
    contrast === null &&
    themeId === null
  if (empty) return { ok: false, reason: "settings.appearance.code.nothing" }
  return { ok: true, code: { themeId, variant, colors, contrast, fonts } }
}

/**
 * 把主题代码应用到某个模式。代码里有主题或颜色时：主题换成代码里的（认不出时用 pigcode），
 * 这个模式的颜色修改整体换成代码里与主题本来的颜色不同的那些，强调色与主题自带的不同才算自定义；
 * 代码里只有对比度或字体时，主题和颜色保持不变。对比度和字体是全局设置，代码里有才改。另一个模式的颜色不变。
 */
export function applyThemeCode(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  mode: Mode,
  code: ThemeCode,
): AppearanceSettings {
  let next = settings
  if (code.themeId !== null || Object.keys(code.colors).length > 0) {
    const known = [...builtInThemes, ...custom].some((theme) => theme.id === code.themeId)
    const themeId = known && code.themeId ? code.themeId : builtInThemes[0].id
    // 与主题本来的颜色（含 tokens.css 的默认值）相同的不算修改，所以原样导出再导入不会多出修改
    const base: ColorOverride = { ...tokenColors(mode), ...findTheme(themeId, custom)[mode] }
    const changed: ColorOverride = {}
    for (const key of colorKeys) {
      const value = code.colors[key]
      if (value && value !== base[key]) changed[key] = value
    }
    next = editSlot(next, mode, {
      themeId,
      accentMode: changed.accent ? "custom" : "default",
    })
    const entry = { ...next.overrides[themeId] }
    if (Object.keys(changed).length > 0) entry[mode] = changed
    else delete entry[mode]
    const overrides = { ...next.overrides }
    if (Object.keys(entry).length > 0) overrides[themeId] = entry
    else delete overrides[themeId]
    next = { ...next, overrides }
  }
  if (code.contrast !== null) next = { ...next, contrast: code.contrast }
  if (code.fonts.ui !== undefined) next = setUiFont(next, code.fonts.ui)
  if (code.fonts.code !== undefined) next = { ...next, codeFont: code.fonts.code }
  return next
}

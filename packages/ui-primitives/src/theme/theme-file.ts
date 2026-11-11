// 负责主题 JSON 的导入解析和导出序列化（格式见规格 §5.7）。
import type { MessageKey } from "../locale/locale"
import type { ModeOverrides } from "./appearance-settings"
import { parseHex } from "./color-math"
import type { ThemeColors, ThemeDefinition } from "./theme-presets"

const SCHEMA = "pigcode-theme/1"

/** 导入结果：成功带主题，失败带原因的文案 key，由界面按当前语言显示。 */
export type ThemeFileResult =
  { ok: true; theme: ThemeDefinition } | { ok: false; reason: MessageKey }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 从任意值读出一组主题颜色；bg 或 fg 不是合法 `#RRGGBB` 时返回 null，非法的 accent 与 diff 颜色被丢弃。 */
export function parseThemeColors(value: unknown): ThemeColors | null {
  if (!isRecord(value)) return null
  const hex = (key: string) => {
    const raw = value[key]
    return typeof raw === "string" ? parseHex(raw) : null
  }
  const bg = hex("bg")
  const fg = hex("fg")
  if (!bg || !fg) return null
  const colors: ThemeColors = { bg, fg }
  for (const key of ["accent", "diffAdded", "diffRemoved"] as const) {
    const color = hex(key)
    if (color) colors[key] = color
  }
  return colors
}

function uniqueName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name
  let n = 2
  while (existing.includes(`${name} ${n}`)) n += 1
  return `${name} ${n}`
}

/** 把一个名字变成不与 existingNames 重复的名字：重复时在后面加 2、3…… */
export function uniqueThemeName(name: string, existing: readonly string[]): string {
  return uniqueName(name, existing)
}

/** 把一套浅色、深色颜色写成主题文件（pigcode-theme/1，两空格缩进）。 */
export function exportThemeFile(name: string, light: ThemeColors, dark: ThemeColors): string {
  return JSON.stringify({ schema: SCHEMA, name, light, dark }, null, 2)
}

/** 解析主题 JSON 文本：保证成功时 builtIn 为 false、light/dark 齐全、名字不与 existingNames 重复。 */
export function parseThemeFile(text: string, existingNames: readonly string[]): ThemeFileResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, reason: "settings.appearance.themeFile.invalidJson" }
  }
  if (!isRecord(data) || data.schema !== SCHEMA) {
    return { ok: false, reason: "settings.appearance.themeFile.wrongSchema" }
  }
  const name = typeof data.name === "string" ? data.name.trim() : ""
  if (!name) return { ok: false, reason: "settings.appearance.themeFile.missingName" }
  const light = parseThemeColors(data.light)
  const dark = parseThemeColors(data.dark)
  const filledLight = light ?? dark
  const filledDark = dark ?? light
  if (!filledLight || !filledDark) {
    return { ok: false, reason: "settings.appearance.themeFile.noColors" }
  }
  return {
    ok: true,
    theme: {
      id: `custom-${crypto.randomUUID()}`,
      name: uniqueName(name, existingNames),
      builtIn: false,
      light: filledLight,
      dark: filledDark,
    },
  }
}

function merged(base: ThemeColors, override: ModeOverrides["light"]): ThemeColors {
  const accent = override?.accent ?? base.accent
  return {
    bg: override?.bg ?? base.bg,
    fg: override?.fg ?? base.fg,
    ...(accent ? { accent } : {}),
  }
}

/** 把主题（含用户修改）输出成两空格缩进的主题 JSON；pigclaude 的颜色取 pigclaudeFallback。 */
export function serializeTheme(
  theme: ThemeDefinition,
  overrides: ModeOverrides | undefined,
  pigclaudeFallback: { light: ThemeColors; dark: ThemeColors },
): string {
  return JSON.stringify(
    {
      schema: SCHEMA,
      name: theme.name,
      light: merged(theme.light ?? pigclaudeFallback.light, overrides?.light),
      dark: merged(theme.dark ?? pigclaudeFallback.dark, overrides?.dark),
    },
    null,
    2,
  )
}

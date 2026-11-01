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

/** 从任意值读出一组主题颜色；bg 或 fg 不是合法 `#RRGGBB` 时返回 null，非法 accent 被丢弃。 */
export function parseThemeColors(value: unknown): ThemeColors | null {
  if (!isRecord(value)) return null
  const bg = typeof value.bg === "string" ? parseHex(value.bg) : null
  const fg = typeof value.fg === "string" ? parseHex(value.fg) : null
  if (!bg || !fg) return null
  const accent = typeof value.accent === "string" ? parseHex(value.accent) : null
  return accent ? { bg, fg, accent } : { bg, fg }
}

function uniqueName(name: string, existing: readonly string[]): string {
  if (!existing.includes(name)) return name
  let n = 2
  while (existing.includes(`${name} ${n}`)) n += 1
  return `${name} ${n}`
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

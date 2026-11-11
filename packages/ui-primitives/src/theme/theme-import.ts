// 负责主题的导入导出：把当前外观（浅色、深色两套颜色）写成主题文件，
// 以及把主题文件或主题代码读成「我的主题」里的一套主题。不碰 DOM 和存储。
import type { MessageKey } from "../locale/locale"
import type { AppearanceSettings } from "./appearance-settings"
import { activeSlot } from "./appearance-settings"
import { black, readableOn } from "./color-math"
import { decodeThemeCode, effectiveColors, tokenColors } from "./theme-code"
import { exportThemeFile, parseThemeFile, uniqueThemeName } from "./theme-file"
import type { ThemeColors, ThemeDefinition } from "./theme-presets"
import { builtInThemes, findTheme } from "./theme-presets"

type Mode = "light" | "dark"

/** 导入结果：成功时带主题和它应该用在哪些模式上（主题文件是两个模式，主题代码只有它自己的模式）。 */
export type ThemeImportResult =
  { ok: true; theme: ThemeDefinition; modes: Mode[] } | { ok: false; reason: MessageKey }

/** 文件名去掉目录和扩展名（含 .pigcode-theme.json 这样的双扩展名），当作主题名。 */
export function themeNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ""
  return base.replace(/(\.pigcode-theme)?\.(json|txt)$/i, "").trim()
}

/**
 * 读一段导入的文本：pigcode-theme/1 主题文件得到浅色、深色两套颜色；主题代码（pigcode 或 Codex）
 * 只有一个模式，缺的颜色用 tokens.css 的默认值补齐，两个模式填同一套，只用在代码自己的模式上。
 * 名字依次取文件里的名字、fallbackName，并且不与 existing 里的名字重复。
 */
export function importTheme(
  text: string,
  fallbackName: string,
  existing: readonly ThemeDefinition[],
): ThemeImportResult {
  // 和内置主题、我的主题都不能重名，否则主题列表里会出现两个一样的名字
  const names = [...builtInThemes, ...existing].map((theme) => theme.name)
  const trimmed = text.trim()
  if (/"schema"\s*:/.test(trimmed)) {
    const file = parseThemeFile(trimmed, names)
    return file.ok ? { ok: true, theme: file.theme, modes: ["light", "dark"] } : file
  }
  const decoded = decodeThemeCode(trimmed)
  if (!decoded.ok) return decoded
  const { code } = decoded
  const guess = code.colors.bg ? (readableOn(code.colors.bg) === black ? "light" : "dark") : "dark"
  const mode: Mode = code.variant ?? guess
  const colors: ThemeColors = { ...tokenColors(mode), ...code.colors }
  return {
    ok: true,
    theme: {
      id: `custom-${crypto.randomUUID()}`,
      name: uniqueThemeName(fallbackName.trim() || "Imported", names),
      builtIn: false,
      light: colors,
      dark: colors,
    },
    modes: [mode],
  }
}

/** 当前外观导出成主题文件：两个模式实际显示的颜色；两个模式用同一个主题时用它的名字。 */
export function exportCurrentTheme(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
): { name: string; fileName: string; text: string } {
  const light = findTheme(activeSlot(settings, "light").themeId, custom)
  const dark = findTheme(activeSlot(settings, "dark").themeId, custom)
  const name = light.id === dark.id ? light.name : `${light.name} + ${dark.name}`
  const slug =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "theme"
  return {
    name,
    fileName: `${slug}.pigcode-theme.json`,
    text: exportThemeFile(
      name,
      effectiveColors(settings, custom, "light"),
      effectiveColors(settings, custom, "dark"),
    ),
  }
}

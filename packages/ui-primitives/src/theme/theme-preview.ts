// 负责外观页里主题小窗的配色：由一个主题的五种颜色推出小窗各部分的颜色，写成 --pv-* 变量。
// 推法与 appearance-tokens 的表面、文字组一致（比例取自 tokens.css），只是更粗略，够画缩略图用。
import { withAlpha } from "./appearance-glass"
import type { AppearanceSettings, ColorKey } from "./appearance-settings"
import { activeSlot } from "./appearance-settings"
import type { Hex } from "./color-math"
import { black, mixHex, readableOn, white } from "./color-math"
import { tokenColors } from "./theme-code"
import type { ThemeDefinition } from "./theme-presets"
import { findTheme } from "./theme-presets"

type Mode = "light" | "dark"

/** 小窗用到的全部颜色，键是 CSS 变量名。 */
export type PreviewPalette = Record<`--pv-${string}`, string>

/** 由五种颜色推出小窗配色：窗框、侧栏、内容区、卡片、文字层级、细线、强调色和 diff。 */
export function previewPalette(colors: Record<ColorKey, Hex>): PreviewPalette {
  const { bg, fg, accent } = colors
  const light = readableOn(bg) === black
  return {
    "--pv-window": light ? mixHex(bg, black, 0.03) : mixHex(bg, black, 0.38),
    "--pv-sidebar": light ? mixHex(bg, black, 0.045) : mixHex(bg, black, 0.3),
    "--pv-bg": bg,
    "--pv-card": light ? mixHex(bg, white, 0.7) : mixHex(bg, white, 0.05),
    "--pv-fg": fg,
    "--pv-muted": mixHex(fg, bg, 0.45),
    "--pv-faint": mixHex(fg, bg, 0.72),
    "--pv-line": withAlpha(fg, light ? 0.1 : 0.12),
    "--pv-hover": withAlpha(fg, light ? 0.06 : 0.08),
    "--pv-accent": accent,
    "--pv-on-accent": readableOn(accent),
    "--pv-accent-soft": withAlpha(accent, 0.16),
    "--pv-add": colors.diffAdded,
    "--pv-add-soft": withAlpha(colors.diffAdded, light ? 0.14 : 0.18),
    "--pv-remove": colors.diffRemoved,
    "--pv-remove-soft": withAlpha(colors.diffRemoved, light ? 0.14 : 0.18),
  }
}

/**
 * 某个主题在某个模式下画缩略图用的五种颜色：tokens.css 的默认值，盖上主题自带的颜色，
 * 再盖上用户对这个主题的修改。强调色的修改只在这个模式正用着该主题、且是自定义强调色时才算，与界面实际效果一致。
 */
export function themeSwatch(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  mode: Mode,
  themeId: string,
): Record<ColorKey, Hex> {
  const theme = findTheme(themeId, custom)
  const slot = activeSlot(settings, mode)
  const changed = { ...settings.overrides[theme.id]?.[mode] }
  if (!(slot.themeId === theme.id && slot.accentMode === "custom")) delete changed.accent
  return { ...tokenColors(mode), ...(theme[mode] ?? {}), ...changed }
}

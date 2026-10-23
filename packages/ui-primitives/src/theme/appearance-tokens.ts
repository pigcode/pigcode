// 负责把外观设置推导成写到 <html> 上的 CSS 变量和 data-* 属性；只输出与 tokens.css 不同的部分。
import type { Hex } from "./color-math"
import { mixHex, readableOn } from "./color-math"
import type { AppearanceSettings } from "./appearance-settings"
import { activeSlot } from "./appearance-settings"
import type { GlassTint, Paint } from "./appearance-glass"
import {
  blendPaint,
  defaultGlass,
  deriveGlassVars,
  paint,
  paintAt,
  pigclaudeOpaque,
  withAlpha,
} from "./appearance-glass"
import type { ThemeDefinition } from "./theme-presets"
import { findTheme } from "./theme-presets"

/** 推导时需要的运行环境：当前实际模式、是否有系统磨砂、平台和系统的减少动态偏好。 */
export type AppearanceEnvironment = {
  resolved: "light" | "dark"
  glass: boolean
  platform: string
  prefersReducedMotion: boolean
}

/** 推导结果：vars 写成 `<html>` 的内联 CSS 变量，attrs 写成 `<html>` 的属性。 */
export type AppearanceOutput = { vars: Record<string, string>; attrs: Record<string, string> }

type Tone = "light" | "dark"
type Vars = Record<string, string>

/** 强调组：只由 accent 决定。 */
export const accentVars = [
  "--primary",
  "--primary-hover",
  "--on-primary",
  "--switch-on",
  "--link",
  "--border-focus",
  "--accent-ring",
] as const

/** 表面组：只由 bg 决定（非磨砂时全部输出；磨砂时表面交给磨砂组）。 */
export const surfaceVars = [
  "--window",
  "--wall-1",
  "--wall-2",
  "--sidebar",
  "--bg",
  "--surface",
  "--panel",
  "--popover",
  "--popover-glass",
  "--avatar",
] as const

/** 文字组：只由 fg 决定。 */
export const textVars = ["--fg", "--fg-2", "--muted", "--faint"] as const

/** 黑白叠色组：颜色取 bg 的明暗，alpha 乘以对比度系数。 */
export const overlayVars = [
  "--border",
  "--border-strong",
  "--divider",
  "--hover",
  "--active",
  "--field",
  "--track",
  "--scroll-thumb",
] as const

type OverlayName = (typeof overlayVars)[number]

// 叠色用的黑与白，取自 tokens.css（浅色是带一点冷调的深灰，不是纯黑）
const ink: Record<Tone, string> = { light: "oklch(21% 0.006 286", dark: "oklch(100% 0 0" }
// 上面两种叠色的近似 sRGB，只用于插值
const inkHex: Record<Tone, Hex> = { light: "#18181B", dark: "#FFFFFF" }

// tokens.css 中叠色变量的 alpha；磨砂下 glass.css 改了其中三项
const overlayBases: Record<Tone, Record<OverlayName, number>> = {
  light: {
    "--border": 0.1,
    "--border-strong": 0.16,
    "--divider": 0.075,
    "--hover": 0.045,
    "--active": 0.075,
    "--field": 0.04,
    "--track": 0.08,
    "--scroll-thumb": 0.18,
  },
  dark: {
    "--border": 0.08,
    "--border-strong": 0.13,
    "--divider": 0.065,
    "--hover": 0.05,
    "--active": 0.085,
    "--field": 0.05,
    "--track": 0.09,
    "--scroll-thumb": 0.18,
  },
}

const glassOverlayBases: Record<Tone, Partial<Record<OverlayName, number>>> = {
  light: { "--border": 0.1, "--divider": 0.09, "--field": 0.05 },
  dark: { "--border": 0.09, "--divider": 0.08, "--field": 0.06 },
}

// glass.css 里头像底也是叠色
const glassAvatarAlpha: Record<Tone, number> = { light: 0.08, dark: 0.1 }

// pigclaude 只改了 fg 时，用来推出次级文字色的背景
const pigclaudeBg: Record<Tone, Hex> = { light: "#F7F7F7", dark: "#151515" }

const defaultContrast = 45
const white: Hex = "#FFFFFF"
const black: Hex = "#000000"

const cjkSans = `"PingFang SC", "Hiragino Sans GB", "Segoe UI Variable Text", "Microsoft YaHei UI", "Noto Sans CJK SC"`
const uiChain = `-apple-system, BlinkMacSystemFont, "SF Pro Text", ${cjkSans}, sans-serif`
const monoChain = `"SF Mono", ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace`

const uiFonts: Record<AppearanceSettings["light"]["uiFont"], string | null> = {
  system: null,
  inter: `"Inter", ${uiChain}`,
  "source-han": `"Source Han Sans SC", ${uiChain}`,
}

const contentFonts: Record<AppearanceSettings["contentFont"], string | null> = {
  same: null,
  serif: `"New York", ui-serif, Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", serif`,
  rounded: `ui-rounded, "SF Pro Rounded", ${cjkSans}, sans-serif`,
}

const codeFonts: Record<AppearanceSettings["codeFont"], string | null> = {
  system: null,
  jetbrains: `"JetBrains Mono", ${monoChain}`,
  fira: `"Fira Code", ${monoChain}`,
  menlo: `Menlo, ${monoChain}`,
}

const round3 = (value: number): number => Number(value.toFixed(3))

const overlay = (tone: Tone, alpha: number): string => `${ink[tone]} / ${round3(alpha)})`

const overlayPaint = (tone: Tone, alpha: number): Paint =>
  paint(inkHex[tone], alpha, overlay(tone, alpha))

const cssOf = (paints: Record<string, Paint>): Vars =>
  Object.fromEntries(Object.entries(paints).map(([name, value]) => [name, value.css]))

/** 背景是浅色还是深色：在其上黑字更清楚就算浅色。 */
const toneOf = (bg: Hex): Tone => (readableOn(bg) === black ? "light" : "dark")

/**
 * 对比度系数：分段线性经过 (0, 0.4)、(45, 1)、(100, 1.8)，单调递增，k(45) = 1。
 */
export function contrastFactor(contrast: number): number {
  const c = Math.min(100, Math.max(0, contrast))
  return c <= defaultContrast
    ? 0.4 + (0.6 * c) / defaultContrast
    : 1 + (0.8 * (c - defaultContrast)) / (100 - defaultContrast)
}

/** 当前模式下实际要推导的颜色；null 表示沿用 tokens.css。 */
type ResolvedColors = { bg: Hex | null; fg: Hex | null; accent: Hex | null; custom: boolean }

function resolveColors(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  resolved: Tone,
): ResolvedColors {
  const slot = activeSlot(settings, resolved)
  const theme = findTheme(slot.themeId, custom)
  const base = theme[resolved]
  const changed = settings.overrides[theme.id]?.[resolved] ?? {}
  const isCustom = slot.accentMode === "custom"
  const accent = isCustom ? (changed.accent ?? base?.accent ?? null) : (base?.accent ?? null)
  return {
    bg: changed.bg ?? base?.bg ?? null,
    fg: changed.fg ?? base?.fg ?? null,
    accent,
    custom: isCustom && accent !== null,
  }
}

function accentGroup(accent: Hex): Vars {
  const on = readableOn(accent)
  return {
    "--primary": accent,
    "--primary-hover": mixHex(accent, on, 0.15),
    "--on-primary": on,
    "--switch-on": accent,
    "--link": accent,
    "--border-focus": accent,
    "--accent-ring": withAlpha(accent, 0.22),
  }
}

// 比例取自 tokens.css 中 pigclaude 各表面相对 --bg 的明暗差
function surfacePaints(bg: Hex, tone: Tone): Record<string, Paint> {
  if (tone === "light") {
    return {
      "--window": paint(mixHex(bg, black, 0.03)),
      "--wall-1": paint(mixHex(bg, black, 0.03), 0),
      "--wall-2": paint(mixHex(bg, black, 0.03), 0),
      "--sidebar": paint(mixHex(bg, black, 0.03), 0.6),
      "--bg": paint(bg),
      "--surface": paint(mixHex(bg, white, 0.7)),
      "--panel": overlayPaint(tone, 0.035),
      "--popover": paint(mixHex(bg, white, 0.6)),
      "--popover-glass": paint(mixHex(bg, white, 0.5), 0.9),
      "--avatar": paint(mixHex(bg, black, 0.1)),
    }
  }
  return {
    "--window": paint(mixHex(bg, black, 0.38)),
    "--wall-1": paint(mixHex(bg, black, 0.38), 0),
    "--wall-2": paint(mixHex(bg, black, 0.38), 0),
    "--sidebar": paint(mixHex(bg, black, 0.38), 0.5),
    "--bg": paint(bg),
    "--surface": paint(mixHex(bg, white, 0.03)),
    "--panel": overlayPaint(tone, 0.03),
    "--popover": paint(mixHex(bg, white, 0.035)),
    "--popover-glass": paint(mixHex(bg, white, 0.035), 0.9),
    "--avatar": paint(mixHex(bg, white, 0.1)),
  }
}

function glassTint(bg: Hex, tone: Tone): GlassTint {
  return tone === "light"
    ? { ground: bg, raised: mixHex(bg, white, 0.7), popover: mixHex(bg, white, 0.6) }
    : { ground: bg, raised: white, popover: mixHex(bg, white, 0.055) }
}

function textGroup(fg: Hex, ground: Hex): Vars {
  return {
    "--fg": fg,
    "--fg-2": mixHex(fg, ground, 0.22),
    "--muted": mixHex(fg, ground, 0.42),
    "--faint": mixHex(fg, ground, 0.62),
  }
}

/** glassMix 为 0 时取 tokens.css 的叠色基准，为 1 时取 glass.css 的（磨砂 g 从 0 到 60）。 */
function overlayGroup(tone: Tone, glassMix: number, contrast: number): Vars {
  const k = contrastFactor(contrast)
  const glassy = glassOverlayBases[tone]
  const vars: Vars = {}
  for (const name of overlayVars) {
    const opaque = overlayBases[tone][name]
    const base = opaque + ((glassy[name] ?? opaque) - opaque) * glassMix
    vars[name] = overlay(tone, Math.min(1, base * k))
  }
  return vars
}

/**
 * 磨砂下的表面：g=0 时等于同一主题的不透明配色（层次与关闭磨砂时相同），
 * 0–60 过渡到 glass.css，60 以上继续变透。侧栏、头像底、输入高光同样从不透明值过渡。
 */
function glassGroup(bg: Hex | null, tone: Tone, env: AppearanceEnvironment, g: number): Vars {
  const opaque = bg ? surfacePaints(bg, tone) : pigclaudeOpaque[tone]
  const tint = bg ? glassTint(bg, tone) : null
  const vars = deriveGlassVars(tone, tint, g, opaque)
  const avatar = overlayPaint(tone, glassAvatarAlpha[tone])
  if (g < defaultGlass) {
    const s = g / defaultGlass
    const sidebar = paintAt(opaque, "--sidebar")
    const fieldHl = paintAt(pigclaudeOpaque[env.resolved], "--field-hl")
    vars["--sidebar"] = blendPaint(sidebar, paint(sidebar.color, 0, "transparent"), s)
    vars["--field-hl"] = blendPaint(fieldHl, paint(fieldHl.color, 0, "transparent"), s)
    vars["--avatar"] = blendPaint(paintAt(opaque, "--avatar"), avatar, s)
  } else if (bg) {
    vars["--avatar"] = avatar.css
  }
  return vars
}

function colorVars(
  colors: ResolvedColors,
  settings: AppearanceSettings,
  env: AppearanceEnvironment,
): Vars {
  const { bg, fg, accent } = colors
  const tone = bg ? toneOf(bg) : env.resolved
  const vars: Vars = {}
  if (accent) Object.assign(vars, accentGroup(accent))
  if (bg && !env.glass) Object.assign(vars, cssOf(surfacePaints(bg, tone)))
  if (fg) Object.assign(vars, textGroup(fg, bg ?? pigclaudeBg[env.resolved]))
  const g = settings.glass
  const glassMix = env.glass ? Math.min(1, g / defaultGlass) : 0
  if (bg || settings.contrast !== defaultContrast || (glassMix < 1 && env.glass)) {
    Object.assign(vars, overlayGroup(tone, glassMix, settings.contrast))
  }
  if (env.glass && (bg || g !== defaultGlass)) Object.assign(vars, glassGroup(bg, tone, env, g))
  return vars
}

function typeVars(settings: AppearanceSettings, env: AppearanceEnvironment): Vars {
  const d = { uiSize: 13, contentSize: 14, codeSize: 11.5 }
  const vars: Vars = {}
  if (settings.uiSize !== d.uiSize) vars["--ui-scale"] = String(settings.uiSize / d.uiSize)
  if (settings.contentSize !== d.contentSize) vars["--fs-content"] = `${settings.contentSize}px`
  if (settings.codeSize !== d.codeSize) vars["--fs-code"] = `${settings.codeSize}px`
  const fonts: [string, string | null][] = [
    ["--font-ui", uiFonts[activeSlot(settings, env.resolved).uiFont]],
    ["--font-content", contentFonts[settings.contentFont]],
    ["--font-mono", codeFonts[settings.codeFont]],
    ["--font-weight-ui", settings.uiWeight === "medium" ? "500" : null],
    ["--font-weight-content", settings.contentWeight === "medium" ? "500" : null],
    ["--font-weight-code", settings.codeWeight === "medium" ? "500" : null],
  ]
  for (const [name, value] of fonts) if (value !== null) vars[name] = value
  return vars
}

function attrsFor(
  settings: AppearanceSettings,
  colors: ResolvedColors,
  env: AppearanceEnvironment,
): Vars {
  const attrs: Vars = {}
  const reduce =
    settings.motion === "on" || (settings.motion === "system" && env.prefersReducedMotion)
  if (reduce) attrs["data-motion"] = "reduce"
  // 「关闭」要压过 app.css 里跟随系统的减少动态规则，所以显式写 full
  if (settings.motion === "off") attrs["data-motion"] = "full"
  if (settings.diffMarker === "sign") attrs["data-diff"] = "sign"
  if (settings.pointerCursor) attrs["data-pointer"] = "true"
  if (!settings.fontSmoothing) attrs["data-smoothing"] = "off"
  if (settings.fullWidth) attrs["data-fullwidth"] = "true"
  // 只要输出了强调组就写 data-accent，滑块填充和焦点光晕随之使用强调色
  if (colors.accent) attrs["data-accent"] = colors.custom ? "custom" : "theme"
  return attrs
}

/**
 * 把外观设置推导成 CSS 变量与 data-* 属性。保证：默认设置下两者都为空对象；
 * pigclaude 只输出用户改过的那一组；各组互不影响；不修改任何输入。
 */
export function deriveAppearance(
  settings: AppearanceSettings,
  custom: readonly ThemeDefinition[],
  env: AppearanceEnvironment,
): AppearanceOutput {
  const colors = resolveColors(settings, custom, env.resolved)
  return {
    vars: { ...colorVars(colors, settings, env), ...typeVars(settings, env) },
    attrs: attrsFor(settings, colors, env),
  }
}

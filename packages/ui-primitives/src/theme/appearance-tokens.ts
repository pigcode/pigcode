// 负责把外观设置推导成写到 <html> 上的 CSS 变量和 data-* 属性；只输出与 tokens.css 不同的部分。
import type { Hex } from "./color-math"
import { black, mixHex, readableOn, white } from "./color-math"
import type { AppearanceSettings } from "./appearance-settings"
import type { CodeFontPreset, UiFontPreset } from "./appearance-settings"
import { activeSlot, cleanFontName } from "./appearance-settings"
import type { GlassTint, Paint } from "./appearance-glass"
import {
  blendPaint,
  defaultGlass,
  defaultTokens,
  deriveGlassVars,
  glassTokens,
  paint,
  paintAt,
  pigclaudeOpaque,
  tokenPaint,
  withAlpha,
} from "./appearance-glass"
import type { ThemeDefinition } from "./theme-presets"
import { findTheme } from "./theme-presets"
import { splitAlpha, supportsTranslucency } from "./theme-tokens"

/** 推导时需要的运行环境：当前实际模式、是否有系统磨砂、平台和系统的减少动态偏好。 */
export type AppearanceEnvironment = {
  resolved: "light" | "dark"
  glass: boolean
  platform: string
  /** 系统版本（Windows 用来判断有没有 acrylic）；不知道时留空。 */
  systemVersion?: string | undefined
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

const byTone = <T>(of: (tone: Tone) => T): Record<Tone, T> => ({
  light: of("light"),
  dark: of("dark"),
})

// 叠色用的墨色，取 tokens.css 里 --border 的颜色部分（浅色是带一点冷调的深灰，不是纯黑）；
// inkHex 是它的近似 sRGB，只用于插值
const ink = byTone((tone) => splitAlpha(defaultTokens[tone]("--border")).color)
const inkHex = byTone((tone) => tokenPaint(ink[tone]).color)

// tokens.css 中叠色变量的 alpha；磨砂下 tokens.css 的磨砂块改了其中三项
const overlayBases = byTone(
  (tone) =>
    Object.fromEntries(
      overlayVars.map((name) => [name, tokenPaint(defaultTokens[tone](name)).alpha]),
    ) as Record<OverlayName, number>,
)

const glassOverlayBases = byTone((tone): Partial<Record<OverlayName, number>> =>
  Object.fromEntries(
    (["--border", "--divider", "--field"] as const).map((name) => [
      name,
      tokenPaint(glassTokens[tone](name)).alpha,
    ]),
  ),
)

// 磨砂块里头像底也是叠色
const glassAvatarAlpha = byTone((tone) => tokenPaint(glassTokens[tone]("--avatar")).alpha)

// pigclaude 只改了 fg 时，用来推出次级文字色的背景
const pigclaudeBg = byTone((tone) => tokenPaint(defaultTokens[tone]("--bg")).color)

const defaultContrast = 45

const cjkSans = `"PingFang SC", "Hiragino Sans GB", "Segoe UI Variable Text", "Microsoft YaHei UI", "Noto Sans CJK SC"`
const uiChain = `-apple-system, BlinkMacSystemFont, "SF Pro Text", ${cjkSans}, sans-serif`
const monoChain = `"SF Mono", ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace`

const uiFonts: Record<UiFontPreset, string | null> = {
  system: null,
  inter: `"Inter", ${uiChain}`,
  "source-han": `"Source Han Sans SC", ${uiChain}`,
}

/** 预设查表；不是预设时把字体名放在对应字体链的最前面，系统没有这个字体就落到后面的。 */
function fontStack(
  value: string,
  presets: Record<string, string | null>,
  chain: string,
): string | null {
  if (Object.hasOwn(presets, value)) return presets[value] ?? null
  const name = cleanFontName(value)
  return name ? `"${name}", ${chain}` : null
}

const contentFonts: Record<AppearanceSettings["contentFont"], string | null> = {
  same: null,
  serif: `"New York", ui-serif, Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", serif`,
  rounded: `ui-rounded, "SF Pro Rounded", ${cjkSans}, sans-serif`,
}

const codeFonts: Record<CodeFontPreset, string | null> = {
  system: null,
  jetbrains: `"JetBrains Mono", ${monoChain}`,
  fira: `"Fira Code", ${monoChain}`,
  menlo: `Menlo, ${monoChain}`,
}

const round3 = (value: number): number => Number(value.toFixed(3))

const overlay = (tone: Tone, alpha: number): string =>
  ink[tone].replace(/\)$/, ` / ${round3(alpha)})`)

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
type ResolvedColors = {
  bg: Hex | null
  fg: Hex | null
  accent: Hex | null
  custom: boolean
  diffAdded: Hex | null
  diffRemoved: Hex | null
}

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
    diffAdded: changed.diffAdded ?? base?.diffAdded ?? null,
    diffRemoved: changed.diffRemoved ?? base?.diffRemoved ?? null,
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

/** diff 的新增行和删除行：行底是半透明的同色，符号和对话里的增删计数直接用这个颜色。 */
function diffGroup(colors: ResolvedColors, tone: Tone): Vars {
  const alpha = tone === "light" ? 0.14 : 0.18
  const vars: Vars = {}
  if (colors.diffAdded) {
    vars["--diff-add-bg"] = withAlpha(colors.diffAdded, alpha)
    vars["--diff-add-fg"] = colors.diffAdded
    vars["--cv-diff-added"] = colors.diffAdded
  }
  if (colors.diffRemoved) {
    vars["--diff-remove-bg"] = withAlpha(colors.diffRemoved, alpha)
    vars["--diff-remove-fg"] = colors.diffRemoved
    vars["--cv-diff-removed"] = colors.diffRemoved
  }
  return vars
}

function textGroup(fg: Hex, ground: Hex): Vars {
  return {
    "--fg": fg,
    "--fg-2": mixHex(fg, ground, 0.22),
    "--muted": mixHex(fg, ground, 0.42),
    "--faint": mixHex(fg, ground, 0.62),
  }
}

/** glassMix 为 0 时取 tokens.css 的叠色基准，为 1 时取磨砂块的（磨砂 g 从 0 到 60）。 */
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
 * 0–60 过渡到 tokens.css 的磨砂块，60 以上继续变透。侧栏、头像底、输入高光同样从不透明值过渡。
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
  // 终端是不透明的一块，磨砂下也一样：浅色主题接近白色的表面，深色主题比底色再暗一点；文字直接用主题前景色
  // ANSI 配色和默认文字色跟随当前明暗，主题背景的明暗和它不一致时终端底色保持默认，免得深底配深字
  if (bg && tone === env.resolved) {
    vars["--term-bg"] = tone === "light" ? mixHex(bg, white, 0.7) : mixHex(bg, black, 0.2)
  }
  if (fg) vars["--term-fg"] = fg
  Object.assign(vars, diffGroup(colors, tone))
  const g = settings.glass
  const glassMix = env.glass ? Math.min(1, g / defaultGlass) : 0
  if (bg || settings.contrast !== defaultContrast || (glassMix < 1 && env.glass)) {
    Object.assign(vars, overlayGroup(tone, glassMix, settings.contrast))
  }
  if (env.glass && (bg || g !== defaultGlass)) Object.assign(vars, glassGroup(bg, tone, env, g))
  return vars
}

/**
 * 侧栏透明度：把窗口底色（侧栏和窗口边框露出来的那层）换成半透明，内容区仍是不透明的卡片。
 * 透明度 100 时页面不再画底色，只剩系统的磨砂材质；材质自带模糊和底色，文字仍然清楚。
 * 磨砂模式自己管窗口底色，这里不插手。
 */
function translucencyVars(
  colors: ResolvedColors,
  settings: AppearanceSettings,
  env: AppearanceEnvironment,
): Vars {
  const t = settings.sidebarTranslucency
  if (t <= 0 || env.glass || !supportsTranslucency(env.platform, env.systemVersion)) return {}
  const tone = colors.bg ? toneOf(colors.bg) : env.resolved
  const window = colors.bg
    ? paintAt(surfacePaints(colors.bg, tone), "--window").color
    : tokenPaint(defaultTokens[env.resolved]("--window")).color
  // --window-solid 是同一个颜色的不透明版本：Windows 的原生标题栏按钮要一个不透明的底色
  return { "--window": withAlpha(window, round3(1 - t / 100)), "--window-solid": window }
}

function typeVars(settings: AppearanceSettings, env: AppearanceEnvironment): Vars {
  const d = { uiSize: 13, contentSize: 14, codeSize: 11.5 }
  const vars: Vars = {}
  if (settings.uiSize !== d.uiSize) vars["--ui-scale"] = String(settings.uiSize / d.uiSize)
  if (settings.contentSize !== d.contentSize) vars["--fs-content"] = `${settings.contentSize}px`
  if (settings.codeSize !== d.codeSize) vars["--fs-code"] = `${settings.codeSize}px`
  const fonts: [string, string | null][] = [
    ["--font-ui", fontStack(activeSlot(settings, env.resolved).uiFont, uiFonts, uiChain)],
    ["--font-content", contentFonts[settings.contentFont]],
    ["--font-mono", fontStack(settings.codeFont, codeFonts, monoChain)],
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
  const canTranslucent = supportsTranslucency(env.platform, env.systemVersion)
  if (settings.sidebarTranslucency > 0 && !env.glass && canTranslucent) {
    attrs["data-translucent"] = "true"
  }
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
    vars: {
      ...colorVars(colors, settings, env),
      ...translucencyVars(colors, settings, env),
      ...typeVars(settings, env),
    },
    attrs: attrsFor(settings, colors, env),
  }
}

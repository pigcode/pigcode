// 负责「磨砂透明度」：磨砂半透明表面的 alpha 基准表、随 g 变化的曲线，以及从不透明配色到磨砂的过渡。
// 基准表与不透明配色都从 tokens.css 原文读出，不另存一份色值。
import tokensCss from "../styles/tokens.css?raw"
import type { Hex } from "./color-math"
import { hexToRgb, rgbToHex } from "./color-math"
import type { TokenReader } from "./theme-tokens"
import { parseCssColor, ruleBlock, splitAlpha, tokenBlock, tokenReader } from "./theme-tokens"

type Tone = "light" | "dark"

/** 一个颜色值：写进 CSS 的原文，以及用于插值的近似 RGB 和 alpha。 */
export type Paint = { css: string; color: Hex; alpha: number }

/** 输出 `rgb(r g b / a)`，alpha 保留三位小数。 */
export function withAlpha(hex: Hex, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${r} ${g} ${b} / ${Number(alpha.toFixed(3))})`
}

/** 由颜色和 alpha 组成 Paint；不给 css 时不透明色写 HEX，半透明写 `rgb(… / a)`。 */
export function paint(color: Hex, alpha = 1, css?: string): Paint {
  return { css: css ?? (alpha === 1 ? color : withAlpha(color, alpha)), color, alpha }
}

/**
 * 把 token 的颜色读成 Paint：css 是原文，color 是去掉透明度后的近似 sRGB（只用于插值），alpha 是透明度。
 * 认不出时抛错：tokens.css 里这些 token 的写法变了，这里要跟着改。
 */
export function tokenPaint(css: string): Paint {
  const { color, alpha } = splitAlpha(css)
  const hex = parseCssColor(color)
  if (!hex) throw new Error(`unsupported token colour: ${css}`)
  return paint(hex, alpha, css)
}

const glassSelector = ':root[data-glass="true"]'

/** tokens.css 的明暗主题块（不含平台附加条件），即 pigclaude 未改设置时的不透明配色。 */
export const defaultTokens: Record<Tone, TokenReader> = {
  light: tokenReader(tokenBlock(tokensCss, "light")),
  dark: tokenReader(tokenBlock(tokensCss, "dark")),
}

/** tokens.css 的磨砂块：深色在浅色磨砂块之上再覆盖一层。 */
export const glassTokens: Record<Tone, TokenReader> = {
  light: tokenReader(ruleBlock(tokensCss, glassSelector)),
  dark: tokenReader({
    ...ruleBlock(tokensCss, glassSelector),
    ...ruleBlock(tokensCss, `${glassSelector}[data-theme="dark"]`),
  }),
}

/** 磨砂下一个半透明表面：变量名、色调来源、在 g=60 时的 alpha。 */
export type GlassBase = {
  name: string
  /** ground 跟随底色；raised 是抬起的表面；popover 是弹层（有 alpha 下限）。 */
  role: "ground" | "raised" | "popover"
  /** pigclaude 未改 bg 时使用的颜色：tokens.css 磨砂块里 oklch 值的近似 sRGB。 */
  color: Hex
  alpha: number
  /** g=0 时对应的不透明变量（--glass-tint 是页面底色，对应 --window）。 */
  opaque: string
}

/**
 * 磨砂下的半透明表面，色调和 alpha 读自 tokens.css 的 :root[data-glass="true"] 两块。
 * 细线、输入底和头像底（--border/--divider/--field/--avatar）不是表面，不在此表，由叠色组处理。
 */
const glassSurfaces: ReadonlyArray<Omit<GlassBase, "color" | "alpha">> = [
  { name: "--glass-tint", role: "ground", opaque: "--window" },
  { name: "--bg", role: "ground", opaque: "--bg" },
  { name: "--surface", role: "raised", opaque: "--surface" },
  { name: "--panel", role: "raised", opaque: "--panel" },
  { name: "--popover", role: "popover", opaque: "--popover" },
  { name: "--popover-glass", role: "popover", opaque: "--popover-glass" },
]

const glassBasesOf = (tone: Tone): GlassBase[] =>
  glassSurfaces.map((surface) => {
    const { color, alpha } = tokenPaint(glassTokens[tone](surface.name))
    return { ...surface, color, alpha }
  })

export const glassBases: Record<Tone, readonly GlassBase[]> = {
  light: glassBasesOf("light"),
  dark: glassBasesOf("dark"),
}

/** 磨砂从不透明配色过渡时用到的变量。 */
const opaqueNames = [
  "--window",
  "--sidebar",
  "--bg",
  "--surface",
  "--panel",
  "--popover",
  "--popover-glass",
  "--avatar",
  "--field-hl",
] as const

const opaqueOf = (tone: Tone): Record<string, Paint> =>
  Object.fromEntries(opaqueNames.map((name) => [name, tokenPaint(defaultTokens[tone](name))]))

/**
 * pigclaude 未改 bg 时的不透明配色：css 是 tokens.css 的原文，
 * color 是对应 oklch 的近似 sRGB，只用于 0 < g < 60 的插值。
 */
export const pigclaudeOpaque: Record<Tone, Record<string, Paint>> = {
  light: opaqueOf("light"),
  dark: opaqueOf("dark"),
}

/** g 的默认值：在这里得到 tokens.css 磨砂块的原值。 */
export const defaultGlass = 60

/** 弹层在任何 g 下的最低 alpha，保证文字可读。 */
export const popoverFloor = 0.6

/**
 * g ≥ 60 一段的 alpha 曲线：(60, base) 到 (100, base × 0.35) 线性下降，不低于 floor。
 * g < 60 时（不透明目标 alpha 为 1 的表面）从 1 线性降到 base；实际输出见 blendPaint。
 */
export function alphaAt(base: number, g: number, floor = 0): number {
  const t = Math.min(100, Math.max(0, g))
  const raw =
    t <= defaultGlass
      ? Math.min(1, base + (1 - base) * ((defaultGlass - t) / defaultGlass))
      : base * (1 - (0.65 * (t - defaultGlass)) / (100 - defaultGlass))
  return Math.max(floor, raw)
}

/**
 * 在预乘 alpha 空间里从 from（s=0）过渡到 to（s=1）：alpha 线性变化，颜色按 alpha 加权，
 * 叠在任何底色上的观感都随 s 线性变化。两端原样返回各自的 css。
 */
export function blendPaint(from: Paint, to: Paint, s: number): string {
  if (s <= 0) return from.css
  if (s >= 1) return to.css
  const alpha = from.alpha + (to.alpha - from.alpha) * s
  if (alpha <= 0) return "transparent"
  const a = hexToRgb(from.color)
  const b = hexToRgb(to.color)
  const mix = (i: 0 | 1 | 2) => (a[i] * from.alpha * (1 - s) + b[i] * to.alpha * s) / alpha
  return withAlpha(rgbToHex([mix(0), mix(1), mix(2)]), alpha)
}

/** 从不透明配色表中取一项；缺失说明调用方用了表里没有的变量。 */
export function paintAt(paints: Record<string, Paint>, name: string): Paint {
  const value = paints[name]
  if (value === undefined) throw new Error(`missing paint: ${name}`)
  return value
}

/** 改了 bg 后各表面的磨砂色调：底层用 bg，抬起的表面和弹层按浅深色从 bg 推出。 */
export type GlassTint = { ground: Hex; raised: Hex; popover: Hex }

/**
 * 按 g 输出磨砂表面变量。opaque 是同一主题同一模式的不透明配色（键为不透明变量名）。
 * g=0 等于 opaque；0–60 在预乘空间里过渡到磨砂块的值；60 以上按 alphaAt 继续变透。
 * tint 为 null 时沿用磨砂块的白/黑色调。
 */
export function deriveGlassVars(
  tone: Tone,
  tint: GlassTint | null,
  g: number,
  opaque: Record<string, Paint>,
): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const item of glassBases[tone]) {
    const color = tint ? tint[item.role] : item.color
    if (g <= defaultGlass) {
      const target = paint(color, item.alpha)
      vars[item.name] = blendPaint(paintAt(opaque, item.opaque), target, g / defaultGlass)
    } else {
      const alpha = alphaAt(item.alpha, g, item.role === "popover" ? popoverFloor : 0)
      vars[item.name] = withAlpha(color, alpha)
    }
  }
  return vars
}

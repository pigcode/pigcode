// 负责「磨砂透明度」：glass.css 半透明表面的 alpha 基准表、随 g 变化的曲线，以及从不透明配色到磨砂的过渡。
import type { Hex } from "./color-math"
import { hexToRgb, rgbToHex } from "./color-math"

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

/** glass.css 中一个半透明表面：变量名、色调来源、在 g=60 时的 alpha。 */
export type GlassBase = {
  name: string
  /** ground 跟随底色；raised 是抬起的表面；popover 是弹层（有 alpha 下限）。 */
  role: "ground" | "raised" | "popover"
  /** pigclaude 未改 bg 时使用的颜色，近似 glass.css 里的 oklch 值。 */
  color: Hex
  alpha: number
  /** g=0 时对应的不透明变量（--glass-tint 是页面底色，对应 --window）。 */
  opaque: string
}

/**
 * 抄自 styles/glass.css 的 [data-glass="true"] 与 [data-glass="true"][data-theme="dark"]。
 * 改 glass.css 时同步改这里。细线、输入底和头像底（--border/--divider/--field/--avatar）
 * 不是表面，不在此表，由叠色组处理。
 */
export const glassBases: Record<Tone, readonly GlassBase[]> = {
  light: [
    { name: "--glass-tint", role: "ground", color: "#FFFFFF", alpha: 0.16, opaque: "--window" },
    { name: "--bg", role: "ground", color: "#FFFFFF", alpha: 0.3, opaque: "--bg" },
    { name: "--surface", role: "raised", color: "#FFFFFF", alpha: 0.62, opaque: "--surface" },
    { name: "--panel", role: "raised", color: "#FFFFFF", alpha: 0.4, opaque: "--panel" },
    { name: "--popover", role: "popover", color: "#FCFCFC", alpha: 0.78, opaque: "--popover" },
    {
      name: "--popover-glass",
      role: "popover",
      color: "#FCFCFC",
      alpha: 0.68,
      opaque: "--popover-glass",
    },
  ],
  dark: [
    { name: "--glass-tint", role: "ground", color: "#000000", alpha: 0.42, opaque: "--window" },
    { name: "--bg", role: "ground", color: "#000000", alpha: 0.14, opaque: "--bg" },
    { name: "--surface", role: "raised", color: "#FFFFFF", alpha: 0.07, opaque: "--surface" },
    { name: "--panel", role: "raised", color: "#FFFFFF", alpha: 0.045, opaque: "--panel" },
    { name: "--popover", role: "popover", color: "#1F1F21", alpha: 0.82, opaque: "--popover" },
    {
      name: "--popover-glass",
      role: "popover",
      color: "#1F1F21",
      alpha: 0.72,
      opaque: "--popover-glass",
    },
  ],
}

/**
 * pigclaude 未改 bg 时的不透明配色，css 原文抄自 styles/tokens.css（改 tokens.css 时同步改这里），
 * color 是对应 oklch 的近似 sRGB，只用于 0 < g < 60 的插值。
 */
export const pigclaudeOpaque: Record<Tone, Record<string, Paint>> = {
  light: {
    "--window": paint("#F1F1F1", 1, "oklch(95.8% 0 0)"),
    "--sidebar": paint("#F1F1F1", 0.6, "oklch(95.8% 0 0 / 0.6)"),
    "--bg": paint("#F7F7F7", 1, "oklch(97.6% 0 0)"),
    "--surface": paint("#FCFCFC", 1, "oklch(99% 0 0)"),
    "--panel": paint("#18181B", 0.035, "oklch(21% 0.006 286 / 0.035)"),
    "--popover": paint("#FFFFFF", 1, "oklch(100% 0 0)"),
    "--popover-glass": paint("#FFFFFF", 0.9, "oklch(100% 0 0 / 0.9)"),
    "--avatar": paint("#E1E1E1", 1, "oklch(91% 0 0)"),
    "--field-hl": paint("#FFFFFF", 0.5, "oklch(100% 0 0 / 0.5)"),
  },
  dark: {
    "--window": paint("#0D0D0D", 1, "oklch(16% 0 0)"),
    "--sidebar": paint("#0D0D0D", 0.5, "oklch(16% 0 0 / 0.5)"),
    "--bg": paint("#151515", 1, "oklch(19.5% 0 0)"),
    "--surface": paint("#1C1C1C", 1, "oklch(22.5% 0 0)"),
    "--panel": paint("#FFFFFF", 0.03, "oklch(100% 0 0 / 0.03)"),
    "--popover": paint("#1D1D1D", 1, "oklch(23% 0 0)"),
    "--popover-glass": paint("#1D1D1D", 0.9, "oklch(23% 0 0 / 0.9)"),
    "--avatar": paint("#2B2B2B", 1, "oklch(29% 0 0)"),
    "--field-hl": paint("#FFFFFF", 0, "oklch(100% 0 0 / 0)"),
  },
}

/** g 的默认值：在这里得到 glass.css 原值。 */
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

/** 从不透明配色表中取一项；键由常量表维护，缺失说明表与 glass.css 不同步。 */
export function paintAt(paints: Record<string, Paint>, name: string): Paint {
  const value = paints[name]
  if (value === undefined) throw new Error(`missing paint: ${name}`)
  return value
}

/** 改了 bg 后各表面的磨砂色调：底层用 bg，抬起的表面和弹层按浅深色从 bg 推出。 */
export type GlassTint = { ground: Hex; raised: Hex; popover: Hex }

/**
 * 按 g 输出磨砂表面变量。opaque 是同一主题同一模式的不透明配色（键为不透明变量名）。
 * g=0 等于 opaque；0–60 在预乘空间里过渡到 glass.css 的值；60 以上按 alphaAt 继续变透。
 * tint 为 null 时沿用 glass.css 的白/黑色调。
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

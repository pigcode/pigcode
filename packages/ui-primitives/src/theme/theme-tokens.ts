// 负责从主题 token 取颜色：解析 tokens.css 的明暗两块、按变量名读值并展开 var()，
// 以及由 token 算出原生标题栏的颜色。不碰 DOM 和 React，主进程也能用。
import type { Hex } from "./color-math"
import { oklchToHex, parseHex } from "./color-math"
import type { ResolvedTheme } from "./theme-model"

/** 按变量名读 token 的 CSS 值；没有这个 token 时返回空串。 */
export type TokenReader = (name: string) => string

/** 把一个 CSS 颜色值换成 `#RRGGBB`，半透明时是 `#RRGGBBAA`；认不出时返回 null。 */
export type ColorResolver = (css: string) => string | null

/** 原生标题栏的底色与窗口按钮的图标色。 */
export type TitleBarColors = { color: Hex; symbolColor: Hex }

/**
 * 取出 CSS 里选择器列表直接含 selector 的规则声明的变量，多条规则按出现顺序合并。
 * 只认完全相同的选择器：`:root[data-glass="true"]` 不会算进 `[data-theme="dark"]`。
 */
export function ruleBlock(css: string, selector: string): Record<string, string> {
  const values: Record<string, string> = {}
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const [, selectors = "", body = ""] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").some((item) => item.trim() === selector)) continue
    for (const [, name = "", value = ""] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      values[name] = value.trim()
    }
  }
  return values
}

/**
 * 取出 tokens.css 里某个明暗块声明的变量。只认选择器列表里直接含 `[data-theme="light"]`
 * 或 `[data-theme="dark"]` 的规则（`:root` 与浅色同一块），平台等附加条件的规则不算。
 */
export function tokenBlock(css: string, tone: ResolvedTheme): Record<string, string> {
  return ruleBlock(css, `[data-theme="${tone}"]`)
}

/** 从一组变量值读 token，并展开其中的 `var(--name)`；缺失或循环引用读成空串。 */
export function tokenReader(values: Readonly<Record<string, string>>): TokenReader {
  const read = (name: string, seen: ReadonlySet<string>): string => {
    const value = values[name]
    if (value === undefined || seen.has(name)) return ""
    const next = new Set(seen).add(name)
    return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref: string) => read(ref, next)).trim()
  }
  return (name) => read(name, new Set())
}

/**
 * 不借助浏览器解析颜色：只认 `#RRGGBB` 和不带透明度的 `oklch(L% C H)`，其他写法返回 null。
 * 主进程用它把 tokens.css 的窗口底色换成十六进制。
 */
export function parseCssColor(css: string): Hex | null {
  const value = css.trim()
  const hex = parseHex(value)
  if (hex) return hex
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/i.exec(value)
  if (!match) return null
  const [, l = "", percent, c = "", h = ""] = match
  return oklchToHex(Number(l) / (percent ? 100 : 1), Number(c), Number(h))
}

/**
 * 拆出颜色函数末尾的透明度：`oklch(L C H / a)` 得到 `oklch(L C H)` 与 a（百分数换成 0–1）；
 * 没有透明度时原样返回，alpha 为 1。
 */
export function splitAlpha(css: string): { color: string; alpha: number } {
  const match = /^(\w+\([^()/]*?)\s*\/\s*([\d.]+)(%?)\s*\)$/.exec(css.trim())
  if (!match) return { color: css.trim(), alpha: 1 }
  const [, head = "", alpha = "", percent] = match
  return { color: `${head})`, alpha: Number(alpha) / (percent ? 100 : 1) }
}

/**
 * 原生标题栏的颜色：底色取 --window（与页面 .titlebar 的底色相同），图标色取 --fg-2。
 * 任一项读不到或不是不透明色（比如磨砂下的 transparent）时返回 null，调用方保持原样。
 */
export function titleBarColors(read: TokenReader, resolve: ColorResolver): TitleBarColors | null {
  const color = parseHex(resolve(read("--window")) ?? "")
  const symbolColor = parseHex(resolve(read("--fg-2")) ?? "")
  return color && symbolColor ? { color, symbolColor } : null
}

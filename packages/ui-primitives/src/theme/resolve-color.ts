// 负责在浏览器里读主题 token 的计算值，并把任意 CSS 颜色（oklch、color-mix、相对颜色）换成十六进制。
import { rgbToHex } from "./color-math"
import type { ColorResolver, TokenReader } from "./theme-tokens"

/** 读根元素上 token 的计算值；var() 已由浏览器展开，内联覆盖（外观设置）也已生效。 */
export function documentTokenReader(root: Element = document.documentElement): TokenReader {
  const style = getComputedStyle(root)
  return (name) => style.getPropertyValue(name).trim()
}

let context: CanvasRenderingContext2D | null | undefined

/** 1×1 的 2D 画布；第一次用到时创建，拿不到（jsdom）时记为 null。 */
function pixelContext(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    context = canvas.getContext("2d", { willReadFrequently: true })
  }
  return context
}

function paint(ctx: CanvasRenderingContext2D, css: string): Uint8ClampedArray {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  return ctx.getImageData(0, 0, 1, 1).data
}

/**
 * 把 CSS 颜色画进 1×1 画布再读像素，得到 `#RRGGBB`；半透明时追加两位透明度成 `#RRGGBBAA`。
 * 画布按 sRGB 存像素，oklch 与 color-mix 都由 Chromium 自己换算。半透明色的 RGB 另用
 * `rgb(from … / 1)` 画成不透明再读，避开预乘透明度的取整误差。浏览器不认识的值、
 * 没有 CSS.supports 或 2D 画布的环境（jsdom）返回 null。
 */
export const resolveCssColor: ColorResolver = (css) => {
  const value = css.trim()
  if (!value || typeof CSS === "undefined" || !CSS.supports("color", value)) return null
  const ctx = pixelContext()
  if (!ctx) return null
  const alpha = paint(ctx, value)[3] ?? 0
  const [r = 0, g = 0, b = 0] = paint(ctx, `rgb(from ${value} r g b / 1)`)
  const hex = rgbToHex([r, g, b])
  return alpha === 255 ? hex : `${hex}${alpha.toString(16).padStart(2, "0").toUpperCase()}`
}

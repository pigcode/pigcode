// 负责外观设置用到的颜色运算：十六进制解析、RGB/HSV 转换、混色和 WCAG 对比度。

/** 形如 `#RRGGBB` 的颜色字符串。 */
export type Hex = `#${string}`

type Rgb = [number, number, number]

/** 纯白与纯黑：混色和对比度计算的两端。 */
export const white: Hex = "#FFFFFF"
export const black: Hex = "#000000"

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** 只接受 `#RRGGBB`（大小写不敏感），合法时返回大写形式，否则返回 null。 */
export function parseHex(value: string): Hex | null {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? (value.toUpperCase() as Hex) : null
}

/** 把 `#RRGGBB` 拆成 0–255 的 RGB 三元组。 */
export function hexToRgb(hex: Hex): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 把 RGB 三元组（会取整并限制在 0–255）合成大写 `#RRGGBB`。 */
export function rgbToHex(rgb: [number, number, number]): Hex {
  const part = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`.toUpperCase() as Hex
}

/** 转成 HSV：h 为 0–360，s、v 为 0–1。灰色的 h 记为 0。 */
export function hexToHsv(hex: Hex): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as Rgb
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : delta / max, max]
}

/** 从 HSV 还原颜色；h 会按 360 取模，s、v 限制在 0–1。 */
export function hsvToHex(h: number, s: number, v: number): Hex {
  const sat = clamp(s, 0, 1)
  const val = clamp(v, 0, 1)
  const hue = (((h % 360) + 360) % 360) / 60
  const c = val * sat
  const x = c * (1 - Math.abs((hue % 2) - 1))
  const m = val - c
  const sector = Math.floor(hue)
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector % 6] as Rgb
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255])
}

/** 在 a 与 b 之间按 t（0 为 a，1 为 b）逐通道线性混合。 */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  return rgbToHex([
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  ])
}

/** WCAG 相对亮度，范围 0（黑）到 1（白）。 */
export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度，与两色顺序无关，范围 1–21。 */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 返回在该底色上对比度更大的文字色：纯黑或纯白。 */
export function readableOn(hex: Hex): "#000000" | "#FFFFFF" {
  return contrastRatio(hex, "#000000") >= contrastRatio(hex, "#FFFFFF") ? "#000000" : "#FFFFFF"
}

/** sRGB 传输函数：线性分量（0–1）编码成显示用的 0–255。 */
const encodeSrgb = (linear: number): number => {
  const v = clamp(linear, 0, 1)
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
}

/**
 * OKLCH 转 `#RRGGBB`：l 为 0–1，c 为色度，h 为角度。超出 sRGB 的分量直接截断，
 * 与 Chromium 把 oklch 画进 sRGB 画布的结果一致（只差取整）。
 */
export function oklchToHex(l: number, c: number, h: number): Hex {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return rgbToHex([
    encodeSrgb(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    encodeSrgb(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    encodeSrgb(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ])
}

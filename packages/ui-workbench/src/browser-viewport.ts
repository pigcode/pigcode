/**
 * 响应式视图：页面按设备的视口尺寸渲染，放在页面区正中；页面区放不下时整体缩小显示，
 * 页面自己看到的视口尺寸不变。宿主按 fitViewport 摆放 webview，工具栏用它显示缩放比例。
 */

/** 响应式视图的尺寸；device 是预设的 id，手动改过宽高时是 custom。 */
export interface BrowserViewport {
  device: string
  width: number
  height: number
}

/** 一个设备预设；name 为 null 时名字来自文案（笔记本、桌面）。 */
export interface DevicePreset {
  id: string
  name: string | null
  width: number
  height: number
}

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-15-pro", name: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "pixel-8", name: "Pixel 8", width: 412, height: 915 },
  { id: "ipad-mini", name: "iPad mini", width: 768, height: 1024 },
  { id: "ipad-pro", name: "iPad Pro 11″", width: 834, height: 1194 },
  { id: "laptop", name: null, width: 1280, height: 800 },
  { id: "desktop", name: null, width: 1440, height: 900 },
]

/** 打开响应式视图时的默认设备。 */
export const DEFAULT_VIEWPORT: BrowserViewport = {
  device: "iphone-15-pro",
  width: 393,
  height: 852,
}

/** 手动输入的宽高范围。 */
export const VIEWPORT_MIN = 200
export const VIEWPORT_MAX = 3840

/** 设备外框到页面区边缘的留白。 */
const GUTTER = 16

/** 设备在页面区里的位置与缩放：x、y 相对页面区左上角，width、height 是缩放后的显示尺寸。 */
export interface ViewportFrame {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

/** 把设备视口放进页面区：居中，放不下时等比缩小，不放大。 */
export function fitViewport(
  area: { width: number; height: number },
  viewport: { width: number; height: number },
): ViewportFrame {
  const room = {
    width: Math.max(1, area.width - GUTTER * 2),
    height: Math.max(1, area.height - GUTTER * 2),
  }
  const scale = Math.min(1, room.width / viewport.width, room.height / viewport.height)
  const width = Math.round(viewport.width * scale)
  const height = Math.round(viewport.height * scale)
  return {
    x: Math.round((area.width - width) / 2),
    y: Math.round((area.height - height) / 2),
    width,
    height,
    scale,
  }
}

/** 托盘图标与菜单（pigcode/pigcode#64）：关闭窗口后从这里找回窗口或退出。 */
import { Menu, Tray, nativeImage, type NativeImage } from "electron"
import { trayLabels } from "./locale/tray"

/** 图标边长。托盘图标由系统缩放，16 在 macOS 菜单栏上是标准尺寸。 */
const ICON_SIZE = 16

/**
 * 占位图标：一个空心圆角方块。正式图标由产品标识的 ticket 提供。
 * macOS 的菜单栏图标是模板图，只用透明度，颜色由系统按明暗主题决定。
 */
export function placeholderIcon(): NativeImage {
  const pixels = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4)
  const inset = 2
  const outer = ICON_SIZE - inset * 2
  const innerInset = 4
  for (let y = 0; y < ICON_SIZE; y += 1) {
    for (let x = 0; x < ICON_SIZE; x += 1) {
      const inOuter = roundedSquare(x - inset, y - inset, outer, 4)
      const inInner =
        x >= inset + innerInset &&
        y >= inset + innerInset &&
        x < ICON_SIZE - inset - innerInset &&
        y < ICON_SIZE - inset - innerInset
      if (!inOuter || inInner) continue
      // BGRA：黑色，不透明。
      const offset = (y * ICON_SIZE + x) * 4
      pixels[offset] = 0
      pixels[offset + 1] = 0
      pixels[offset + 2] = 0
      pixels[offset + 3] = 255
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: ICON_SIZE, height: ICON_SIZE })
  if (process.platform === "darwin") image.setTemplateImage(true)
  return image
}

/** 点在圆角方块里；坐标相对方块左上角。 */
function roundedSquare(x: number, y: number, size: number, radius: number): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size) return false
  const cornerX = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0
  const cornerY = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0
  return cornerX === 0 || cornerY === 0 || cornerX * cornerX + cornerY * cornerY <= radius * radius
}

export interface TrayActions {
  show: () => void
  quit: () => void
}

/** 创建托盘。macOS 的菜单栏图标点一下就是菜单；Windows 上左键直接打开窗口，右键是菜单。 */
export function createTray(locale: string, actions: TrayActions): Tray {
  const labels = trayLabels(locale)
  const tray = new Tray(placeholderIcon())
  tray.setToolTip("Pigcode")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.open, click: actions.show },
      { type: "separator" },
      { label: labels.quit, click: actions.quit },
    ]),
  )
  if (process.platform !== "darwin") tray.on("click", actions.show)
  return tray
}

/**
 * 外观相关的 IPC：主题来源、Windows/Linux 标题栏按钮颜色、侧栏透明时的窗口底色，以及导出主题时的保存对话框。
 * 都只接受校验过的值，窗口一律取发消息的那个。
 */
import type {
  BrowserWindow as BrowserWindowType,
  IpcMain,
  NativeTheme,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from "electron"
import { supportsTranslucency } from "@pigcode/ui-primitives/theme-tokens"
import { readTextFileRequest, saveTextFile } from "./save-text-file"
import {
  TITLE_BAR_HEIGHT,
  readThemeSource,
  readTitleBarColors,
  usesTitleBarOverlay,
  windowBackground,
  windowMaterial,
} from "./window-options"

/** 只用到 BrowserWindow 的这一个静态方法。 */
type WindowLookup = { fromWebContents: typeof BrowserWindowType.fromWebContents }

export function registerAppearanceIpc(
  ipcMain: IpcMain,
  windows: WindowLookup,
  nativeTheme: NativeTheme,
  deps: {
    platform: NodeJS.Platform
    systemVersion: string
    downloads: () => string
    showSaveDialog: (
      parent: BrowserWindowType,
      options: SaveDialogOptions,
    ) => Promise<SaveDialogReturnValue>
  },
): void {
  ipcMain.handle("pigcode:set-theme", (_event, value: unknown) => {
    const source = readThemeSource(value)
    if (source) nativeTheme.themeSource = source
  })
  // 原生窗口按钮的底色与图标色跟随页面当前外观；macOS 的交通灯不需要。
  ipcMain.handle("pigcode:title-bar", (event, value: unknown) => {
    const colors = readTitleBarColors(value)
    const window = windows.fromWebContents(event.sender)
    if (!colors || !window || !usesTitleBarOverlay(deps.platform)) return
    window.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
  })
  // 侧栏透明：窗口底色设成透明，并换成更透的系统材质（见 windowMaterial），背后的颜色才能透出来；
  // 关掉时换回默认主题的窗口色，避免缩放窗口时露出透明的边。Linux 没有系统材质，页面不会开这个开关。
  ipcMain.handle("pigcode:set-translucent", (event, value: unknown) => {
    const window = windows.fromWebContents(event.sender)
    if (!window || typeof value !== "boolean") return
    // 没有可用材质的系统（Linux、Windows 10）不动窗口：透明底色在那里只会变黑
    if (!supportsTranslucency(deps.platform, deps.systemVersion)) return
    window.setBackgroundColor(windowBackground(value, nativeTheme.shouldUseDarkColors))
    const material = windowMaterial(deps.platform, value)
    if (material && "vibrancy" in material) window.setVibrancy(material.vibrancy)
    if (material && "backgroundMaterial" in material) {
      window.setBackgroundMaterial(material.backgroundMaterial)
    }
  })
  // 导出主题：页面给文件名和内容，主进程弹保存对话框后写文件；返回是否真的写了。
  ipcMain.handle("pigcode:save-text-file", (event, fileName: unknown, text: unknown) => {
    const window = windows.fromWebContents(event.sender)
    const request = readTextFileRequest(fileName, text)
    if (!window || !request) return false
    return saveTextFile(deps.showSaveDialog, window, deps.downloads(), request)
  })
}

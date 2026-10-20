/** 按平台生成主窗口选项；保持 sandbox 与 pigclaude 的窗口质感。 */
import type { BrowserWindowConstructorOptions } from "electron"

/** 窗口原生外观可以跟随的主题来源。 */
export type ThemeSource = "light" | "dark" | "system"

/** 校验渲染进程传来的外观；不认识的值返回 null，主进程忽略它。 */
export function readThemeSource(value: unknown): ThemeSource | null {
  return value === "light" || value === "dark" || value === "system" ? value : null
}

/** 按平台生成窗口选项。macOS 用隐藏标题栏和磨砂材质，Windows 用 mica。 */
export function createMainWindowOptions({
  platform,
  preloadPath,
  isPackaged,
}: {
  platform: NodeJS.Platform
  preloadPath: string
  isPackaged: boolean
}): BrowserWindowConstructorOptions {
  const options: BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: "#F4F4F5",
    autoHideMenuBar: true,
    title: "Pigcode",
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !isPackaged,
    },
  }
  if (platform === "darwin") {
    return {
      ...options,
      vibrancy: "sidebar",
      visualEffectState: "active",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 12 },
    }
  }
  if (platform === "win32") {
    return {
      ...options,
      backgroundMaterial: "mica",
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 40, color: "#00000000", symbolColor: "#52525B" },
    }
  }
  return options
}

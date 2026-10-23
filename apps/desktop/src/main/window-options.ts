/** 按平台生成主窗口选项：窗口按钮一律交给系统绘制，渲染进程只画按钮旁边的外壳。 */
import type { BrowserWindowConstructorOptions } from "electron"

/** 窗口原生外观可以跟随的主题来源。 */
export type ThemeSource = "light" | "dark" | "system"

/** 校验渲染进程传来的外观；不认识的值返回 null，主进程忽略它。 */
export function readThemeSource(value: unknown): ThemeSource | null {
  return value === "light" || value === "dark" || value === "system" ? value : null
}

/** Windows/Linux 自绘标题栏的高度；原生窗口按钮与它等高。 */
export const TITLE_BAR_HEIGHT = 36

/** macOS 交通灯的位置：竖直居中在 40px 高的侧栏顶行里。 */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: 12 }

/** 标题栏底色与原生窗口按钮的图标色。 */
export interface TitleBarColors {
  color: string
  symbolColor: string
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** 页面上报外观之前使用的颜色，与 tokens.css 的窗口底色和次级文字一致。 */
export function defaultTitleBarColors(dark: boolean): TitleBarColors {
  return dark
    ? { color: "#0D0D0D", symbolColor: "#D4D4D8" }
    : { color: "#F1F1F1", symbolColor: "#3F3F46" }
}

/** 校验渲染进程上报的标题栏颜色；只接受 6 位十六进制色，其他输入返回 null。 */
export function readTitleBarColors(value: unknown): TitleBarColors | null {
  if (typeof value !== "object" || value === null) return null
  const { color, symbolColor } = value as Record<string, unknown>
  if (typeof color !== "string" || typeof symbolColor !== "string") return null
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return null
  return { color, symbolColor }
}

/** Windows 与 Linux 隐藏系统标题栏，原生窗口按钮以 overlay 的形式叠在自绘标题栏上。 */
export function usesTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux"
}

/**
 * 按平台生成窗口选项。macOS 保留原生交通灯并移到侧栏顶行；
 * Windows/Linux 用 titleBarOverlay 显示系统的最小化、最大化与关闭按钮。
 */
export function createMainWindowOptions({
  platform,
  preloadPath,
  isPackaged,
  dark = false,
}: {
  platform: NodeJS.Platform
  preloadPath: string
  isPackaged: boolean
  dark?: boolean
}): BrowserWindowConstructorOptions {
  const options: BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: defaultTitleBarColors(dark).color,
    autoHideMenuBar: true,
    title: "Pigcode",
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !isPackaged,
      // 右栏的内置浏览器是 <webview>；它的配置在 main 的 will-attach-webview 里统一收紧。
      webviewTag: true,
    },
  }
  if (platform === "darwin") {
    return {
      ...options,
      vibrancy: "sidebar",
      visualEffectState: "active",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    }
  }
  if (usesTitleBarOverlay(platform)) {
    return {
      ...options,
      ...(platform === "win32" ? { backgroundMaterial: "mica" as const } : {}),
      titleBarStyle: "hidden",
      titleBarOverlay: { ...defaultTitleBarColors(dark), height: TITLE_BAR_HEIGHT },
    }
  }
  return options
}

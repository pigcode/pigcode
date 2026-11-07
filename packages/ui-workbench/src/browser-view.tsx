/**
 * 浏览器 surface：上面是工具栏，打开响应式视图时下面多一条设备栏。页面本身是宿主盖上来的 webview
 * （这里只放占位槽 slot），agent 在后台也能操作它；agent 动手、正在选择元素这些提示由宿主浮在页面上，
 * 不挤动页面。没有页面、加载失败或页面崩溃时，页面区画对应的状态。
 */
import { useState, type ReactNode } from "react"
import { useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { BrowserDeviceBar } from "./browser-device-bar"
import {
  BrowserCrashState,
  BrowserEmptyState,
  BrowserLoadErrorState,
  type BrowserCrash,
  type BrowserLoadError,
} from "./browser-states"
import { BrowserToolbar } from "./browser-toolbar"
import { DEFAULT_VIEWPORT, type BrowserViewport } from "./browser-viewport"

/** 在独立窗口打开页面的原生桥签名；测试可注入替身。 */
export type PreviewOpen = (url: string) => Promise<{ id: string }>

/** agent 动作名对应的文案；没有列出的动作原样显示。 */
export const BROWSER_ACTION_LABELS: Record<string, MessageKey> = {
  open: "browser.action.open",
  navigate: "browser.action.navigate",
  back: "browser.action.back",
  forward: "browser.action.forward",
  reload: "browser.action.reload",
  snapshot: "browser.action.snapshot",
  click: "browser.action.click",
  type: "browser.action.type",
  press: "browser.action.press",
  scroll: "browser.action.scroll",
  wait: "browser.action.wait",
  evaluate: "browser.action.evaluate",
  screenshot: "browser.action.screenshot",
}

/** 页面状态，来自 webview 的导航事件。 */
export interface BrowserPageView {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string | null | undefined
  error?: BrowserLoadError | null | undefined
  crashed?: BrowserCrash | null | undefined
}

/** 默认通过 preload 暴露的 pigcodeNative 打开窗口。 */
function openInNativeWindow(url: string): Promise<{ id: string }> {
  const bridge = typeof window === "undefined" ? undefined : window.pigcodeNative
  if (!bridge?.previewOpen) return Promise.reject(new Error("PREVIEW_BRIDGE_UNAVAILABLE"))
  return bridge.previewOpen(url)
}

/** 把主进程错误码映射成可读文案；未知错误原样展示。 */
function openError(error: unknown, t: (key: MessageKey) => string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("PREVIEW_URL_NOT_ALLOWED")) return t("preview.localOnly")
  if (message.includes("PREVIEW_BRIDGE_UNAVAILABLE")) return t("preview.bridgeMissing")
  return message
}

/** 浏览器属性。 */
export interface BrowserViewProps {
  page: BrowserPageView
  /** 响应式视图的尺寸；null 时页面铺满页面区。 */
  viewport?: BrowserViewport | null | undefined
  /** 响应式视图的缩放比例：页面区放不下设备尺寸时小于 1。 */
  viewportScale?: number | undefined
  /** 正在页面上选择元素。 */
  picking?: boolean | undefined
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop?: (() => void) | undefined
  onViewportChange?: ((viewport: BrowserViewport | null) => void) | undefined
  onTogglePicker?: (() => void) | undefined
  onOpenDevTools?: (() => void) | undefined
  /** 在系统默认浏览器里打开。 */
  onOpenDefault?: ((url: string) => void | Promise<void>) | undefined
  /** 复制当前地址；宿主负责提示已复制。 */
  onCopyUrl?: ((url: string) => void) | undefined
  openExternal?: PreviewOpen
  /** 页面区的占位槽；宿主把 webview 盖在它上面。 */
  slot: ReactNode
}

/** 浏览器 surface。 */
export function BrowserView({
  page,
  viewport = null,
  viewportScale = 1,
  picking = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onViewportChange,
  onTogglePicker,
  onOpenDevTools,
  onOpenDefault,
  onCopyUrl,
  openExternal = openInNativeWindow,
  slot,
}: BrowserViewProps) {
  const { t } = useLocale()
  const current = page.url && page.url !== "about:blank" ? page.url : ""
  const [error, setError] = useState<string | null>(null)

  async function openWindow(): Promise<void> {
    if (!current) return
    setError(null)
    try {
      await openExternal(current)
    } catch (cause) {
      setError(openError(cause, t))
    }
  }

  return (
    <div className="browser-view" data-responsive={viewport ? "" : undefined}>
      <BrowserToolbar
        url={current}
        favicon={page.favicon}
        loading={page.loading}
        canGoBack={page.canGoBack}
        canGoForward={page.canGoForward}
        responsive={viewport !== null}
        picking={picking}
        onNavigate={onNavigate}
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
        onStop={onStop}
        onToggleResponsive={
          onViewportChange ? () => onViewportChange(viewport ? null : DEFAULT_VIEWPORT) : undefined
        }
        onTogglePicker={onTogglePicker}
        onOpenDefault={onOpenDefault ? () => void onOpenDefault(current) : undefined}
        onOpenWindow={() => void openWindow()}
        onCopyUrl={onCopyUrl ? () => onCopyUrl(current) : undefined}
        onOpenDevTools={onOpenDevTools}
        onInvalid={setError}
      />
      {viewport && onViewportChange ? (
        <BrowserDeviceBar viewport={viewport} scale={viewportScale} onChange={onViewportChange} />
      ) : null}
      {error ? (
        <p className="browser-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="browser-page">
        {page.crashed ? (
          <BrowserCrashState crash={page.crashed} onRetry={onReload} />
        ) : page.error ? (
          <BrowserLoadErrorState error={page.error} onRetry={onReload} />
        ) : current ? null : (
          <BrowserEmptyState />
        )}
        {slot}
      </div>
    </div>
  )
}

/**
 * 所有线程的内置浏览器 webview 都挂在这里（渲染到 body 下），不随右栏或线程切换卸载：
 * 槽可见时 webview 盖在槽上，否则移到屏幕外继续运行，agent 可以在后台操作。
 * agent 每个动作在页面上闪一下指示，点击处显示一个落点。
 */
import { createElement, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { browserSessions, useBrowserVersion } from "./browser-sessions"

/** 一个浏览器标签：属于哪个线程、首次打开的地址。 */
export interface HostedBrowser {
  id: string
  threadId: string
  initialUrl?: string | undefined
}

/** webview 元素上用到的方法。 */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
}

const PARTITION = "persist:pigcode-browser"
/** 屏幕外运行时的尺寸；保持常见视口大小，页面布局与截图都稳定。 */
const OFFSCREEN = { width: 1280, height: 800 }

function isHttp(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url)
}

function HostedWebview({
  browser,
  onNavigate,
}: {
  browser: HostedBrowser
  onNavigate: (browser: HostedBrowser, url: string) => void
}) {
  useBrowserVersion()
  const ref = useRef<WebviewElement | null>(null)
  const [src] = useState(() => (isHttp(browser.initialUrl) ? browser.initialUrl : "about:blank"))
  const last = useRef(OFFSCREEN)
  const navigate = useRef(onNavigate)
  navigate.current = onNavigate
  const slot = browserSessions.slot(browser.id)
  const activity = browserSessions.activity(browser.id)
  const page = browserSessions.page(browser.id)

  useEffect(() => {
    const webview = ref.current
    if (!webview) return undefined
    const { id, threadId } = browser
    let registered = false
    const sync = () => {
      browserSessions.updatePage(id, {
        url: webview.getURL(),
        title: webview.getTitle(),
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      })
    }
    const onReady = () => {
      if (!registered) {
        registered = true
        void window.pigcodeNative?.browser?.register(id, threadId, webview.getWebContentsId())
      }
      sync()
    }
    const onNavigated = (event: Event) => {
      sync()
      const url = (event as Event & { url?: string }).url
      if (isHttp(url)) navigate.current(browser, url)
    }
    const onTitle = () => sync()
    const onStart = () => browserSessions.updatePage(id, { loading: true })
    const onStop = () => {
      browserSessions.updatePage(id, { loading: false })
      sync()
    }
    webview.addEventListener("dom-ready", onReady)
    webview.addEventListener("did-navigate", onNavigated)
    webview.addEventListener("did-navigate-in-page", onNavigated)
    webview.addEventListener("page-title-updated", onTitle)
    webview.addEventListener("did-start-loading", onStart)
    webview.addEventListener("did-stop-loading", onStop)
    browserSessions.register(id, {
      back: () => webview.goBack(),
      forward: () => webview.goForward(),
      reload: () => webview.reload(),
      load: (url) => void webview.loadURL(url).catch(() => undefined),
    })
    return () => {
      webview.removeEventListener("dom-ready", onReady)
      webview.removeEventListener("did-navigate", onNavigated)
      webview.removeEventListener("did-navigate-in-page", onNavigated)
      webview.removeEventListener("page-title-updated", onTitle)
      webview.removeEventListener("did-start-loading", onStart)
      webview.removeEventListener("did-stop-loading", onStop)
      browserSessions.unregister(id)
      window.pigcodeNative?.browser?.unregister(id)
    }
    // webview 的身份由 id 决定；地址变化只走导航，不重建监听。
  }, [browser.id, browser.threadId])

  const shown = Boolean(slot?.visible && slot.width > 0 && slot.height > 0)
  if (shown && slot) last.current = { width: slot.width, height: slot.height }
  // 空白页时把槽让给空状态提示；webview 仍然挂着，随时可以导航。
  const blank = !page.url || page.url === "about:blank"
  const style =
    shown && slot
      ? { left: slot.x, top: slot.y, width: slot.width, height: slot.height }
      : { left: -20000, top: 0, width: last.current.width, height: last.current.height }
  const recent = activity ?? null
  return (
    <div
      className="browser-hosted"
      data-browser-id={browser.id}
      data-shown={shown || undefined}
      data-blank={blank || undefined}
      data-agent={recent ? true : undefined}
      style={style}
    >
      {createElement("webview", {
        ref,
        src,
        partition: PARTITION,
        webpreferences: "contextIsolation=yes,sandbox=yes,backgroundThrottling=no",
        className: "browser-webview",
      })}
      {recent?.point ? (
        <span
          key={recent.at}
          className="browser-pointer"
          style={{ left: recent.point.x, top: recent.point.y }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}

/** 渲染所有浏览器 webview，并转发 agent 的活动通知。 */
export function BrowserHost({
  browsers,
  onNavigate,
}: {
  browsers: readonly HostedBrowser[]
  onNavigate: (browser: HostedBrowser, url: string) => void
}) {
  useEffect(
    () =>
      window.pigcodeNative?.browser?.onActivity((activity) => {
        browserSessions.setActivity(activity.sessionId, {
          action: activity.action,
          detail: activity.detail,
          point: activity.point,
          at: Date.now(),
        })
      }),
    [],
  )
  if (typeof document === "undefined" || !window.pigcodeNative?.browser) return null
  return createPortal(
    <div className="browser-host">
      {browsers.map((browser) => (
        <HostedWebview key={browser.id} browser={browser} onNavigate={onNavigate} />
      ))}
    </div>,
    document.body,
  )
}

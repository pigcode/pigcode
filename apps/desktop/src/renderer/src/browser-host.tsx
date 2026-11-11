/**
 * 所有线程的内置浏览器 webview 都挂在这里（渲染到 body 下），不随右栏或线程切换卸载：
 * 槽可见时 webview 盖在槽上，否则移到屏幕外继续运行，agent 可以在后台操作。
 * 响应式视图打开时 webview 按设备尺寸渲染、居中，放不下时整体缩小。
 * 页面上方浮着一条提示：agent 正在做什么、正在选择元素、已加入聊天；它跟着 webview 走，不挤动页面。
 * agent 每个动作在页面上闪一下指示，点击处显示一个落点。
 */
import { createElement, useEffect, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Bot, Check, SquareMousePointer, TriangleAlert } from "lucide-react"
import { DotMatrix, useLocale } from "@pigcode/ui-primitives"
import { BROWSER_ACTION_LABELS, fitViewport } from "@pigcode/ui-workbench"
import { browserSessions, useBrowserVersion } from "./browser-sessions"
import { CANCEL_PICKER_SCRIPT, pickerScript } from "./browser-picker"

/** 一个浏览器标签：在哪个面板里、属于哪个线程、首次打开的地址。 */
export interface HostedBrowser {
  id: string
  /** 面板在 App 里的 key；标签的标题与图标写回这个面板。 */
  slotKey: string
  /**
   * 新会话草稿里打开的浏览器还不属于会话，为 null：这时不交给 agent 控制，
   * 草稿建成会话后换成会话 id，再交给那个会话的 agent。
   */
  threadId: string | null
  initialUrl?: string | undefined
}

/** 页面变化后标签要显示的东西：地址、标题（没有时是主机名）与网站图标。 */
export interface BrowserTabPatch {
  url: string
  title: string
  icon: string | undefined
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
  stop(): void
  openDevTools(): void
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

/** webview 事件里带的字段。 */
type WebviewEvent = Event & {
  url?: string
  isMainFrame?: boolean
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
  favicons?: string[]
  details?: { reason?: string }
}

const PARTITION = "persist:pigcode-browser"
/** 屏幕外运行时的尺寸；保持常见视口大小，页面布局与截图都稳定。 */
const OFFSCREEN = { width: 1280, height: 800 }
/** 用户取消的导航（ERR_ABORTED），不是加载失败。 */
const ABORTED = -3

function isHttp(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url)
}

/** 页面没写标题时 Chromium 拿地址的显示形式当标题（去掉协议，有时去掉结尾的 /）；这种情况算没有标题。 */
function hasOwnTitle(title: string, url: string): boolean {
  const bare = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/$/, "")
  return title.trim() !== "" && bare(title) !== bare(url)
}

/** 页面声明的网站图标里第一个能显示的。 */
function faviconOf(favicons: readonly string[] | undefined): string | null {
  return favicons?.find((icon) => /^(https?:|data:image\/)/i.test(icon)) ?? null
}

/** 页面上方的浮动提示：agent 动手时最优先，其次是正在选择元素，最后是短提示。 */
function BrowserToast({ id }: { id: string }) {
  const { t } = useLocale()
  const activity = browserSessions.activity(id)
  const notice = browserSessions.notice(id)
  if (activity) {
    const key = BROWSER_ACTION_LABELS[activity.action]
    return (
      <div className="browser-toast" data-tone="agent" role="status" aria-live="polite">
        <Bot className="ic ic-sm" aria-hidden="true" />
        <span className="browser-toast-label">{t("browser.agent")}</span>
        <span className="truncate">
          {[key ? t(key) : activity.action, activity.detail].filter(Boolean).join(" · ")}
        </span>
        <DotMatrix />
      </div>
    )
  }
  if (browserSessions.isPicking(id)) {
    return (
      <div className="browser-toast" data-tone="picker" role="status" aria-live="polite">
        <SquareMousePointer className="ic ic-sm" aria-hidden="true" />
        <span className="truncate">{t("browser.picker.hint")}</span>
        <button
          type="button"
          className="browser-toast-action"
          onClick={() => {
            browserSessions.cancelPick(id)
            browserSessions.setPicking(id, false)
          }}
        >
          {t("browser.picker.cancel")}
        </button>
      </div>
    )
  }
  if (!notice) return null
  return (
    <div className="browser-toast" data-tone={notice.tone} role="status" aria-live="polite">
      {notice.tone === "warn" ? (
        <TriangleAlert className="ic ic-sm" aria-hidden="true" />
      ) : (
        <Check className="ic ic-sm" aria-hidden="true" />
      )}
      <span className="truncate">{notice.text}</span>
    </div>
  )
}

function HostedWebview({
  browser,
  onPage,
}: {
  browser: HostedBrowser
  onPage: (browser: HostedBrowser, patch: BrowserTabPatch) => void
}) {
  useBrowserVersion()
  const ref = useRef<WebviewElement | null>(null)
  const [src] = useState(() => (isHttp(browser.initialUrl) ? browser.initialUrl : "about:blank"))
  const last = useRef(OFFSCREEN)
  const report = useRef(onPage)
  report.current = onPage
  const slot = browserSessions.slot(browser.id)
  const activity = browserSessions.activity(browser.id)
  const page = browserSessions.page(browser.id)
  const viewport = browserSessions.viewport(browser.id)

  useEffect(() => {
    const webview = ref.current
    if (!webview) return undefined
    const { id, threadId } = browser
    let registered = false
    let favicon: string | null = null
    let reported = ""
    const sync = () => {
      const url = webview.getURL()
      browserSessions.updatePage(id, {
        // 加载失败后 webview 停在 Chromium 的错误页上，地址栏继续显示没打开的那个地址。
        ...(url.startsWith("chrome-error:") ? {} : { url }),
        title: webview.getTitle(),
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      })
    }
    /** 把标题、图标和地址交给标签；没变时不打扰。 */
    const tell = () => {
      const url = webview.getURL()
      if (!isHttp(url)) return
      const title = webview.getTitle()
      const patch = {
        url,
        title: hasOwnTitle(title, url) ? title : new URL(url).host,
        icon: favicon ?? undefined,
      }
      const key = JSON.stringify(patch)
      if (key === reported) return
      reported = key
      report.current(browser, patch)
    }
    /** 页面就绪后交给会话的 agent；草稿里还没有会话，等建好会话、threadId 变了再交。 */
    const registerWithAgent = () => {
      if (registered || !threadId) return
      registered = true
      void window.pigcodeNative?.browser?.register(id, threadId, webview.getWebContentsId())
    }
    const onReady = () => {
      registerWithAgent()
      sync()
    }
    const onNavigated = (event: Event) => {
      // 换了页面：旧网站的图标不再适用，新页面声明图标时再换上。
      favicon = null
      browserSessions.updatePage(id, { favicon: null })
      sync()
      if (isHttp((event as WebviewEvent).url)) tell()
    }
    const onInPage = (event: Event) => {
      sync()
      if (isHttp((event as WebviewEvent).url)) tell()
    }
    const onTitle = () => {
      sync()
      tell()
    }
    const onFavicon = (event: Event) => {
      favicon = faviconOf((event as WebviewEvent).favicons)
      browserSessions.updatePage(id, { favicon })
      tell()
    }
    const onStart = () => {
      // 新的导航开始：之前的失败与崩溃都作废；页面要换了，还在进行的元素选择也停下。
      browserSessions.updatePage(id, { loading: true, error: null, crashed: null })
      browserSessions.setPicking(id, false)
    }
    const onStop = () => {
      browserSessions.updatePage(id, { loading: false })
      sync()
    }
    const onFail = (event: Event) => {
      const {
        errorCode = 0,
        errorDescription = "",
        validatedURL = "",
        isMainFrame,
      } = event as WebviewEvent
      if (!isMainFrame || errorCode === ABORTED) return
      browserSessions.updatePage(id, {
        loading: false,
        error: { code: errorCode, description: errorDescription, url: validatedURL },
        ...(isHttp(validatedURL) ? { url: validatedURL } : {}),
      })
    }
    const onGone = (event: Event) => {
      browserSessions.updatePage(id, {
        loading: false,
        crashed: { reason: (event as WebviewEvent).details?.reason ?? "crashed" },
      })
      browserSessions.setPicking(id, false)
    }
    const listeners: Array<[string, (event: Event) => void]> = [
      ["dom-ready", onReady],
      ["did-navigate", onNavigated],
      ["did-navigate-in-page", onInPage],
      ["page-title-updated", onTitle],
      ["page-favicon-updated", onFavicon],
      ["did-start-loading", onStart],
      ["did-stop-loading", onStop],
      ["did-fail-load", onFail],
      ["render-process-gone", onGone],
    ]
    for (const [type, listener] of listeners) webview.addEventListener(type, listener)
    // 草稿建成会话时 threadId 才有值，页面早就绪了，不会再来 dom-ready：能取到 webContents 就直接交。
    try {
      webview.getWebContentsId()
      registerWithAgent()
    } catch {
      // 还没就绪；等 dom-ready。
    }
    browserSessions.register(id, {
      back: () => webview.goBack(),
      forward: () => webview.goForward(),
      reload: () => webview.reload(),
      stop: () => webview.stop(),
      devtools: () => webview.openDevTools(),
      load: (url) => void webview.loadURL(url).catch(() => undefined),
      pick: () => {
        // 让页面拿到焦点：悬停高亮和 Esc 取消都在页面里处理。
        webview.focus()
        return webview.executeJavaScript(pickerScript(), true)
      },
      cancelPick: () => void webview.executeJavaScript(CANCEL_PICKER_SCRIPT).catch(() => undefined),
    })
    return () => {
      for (const [type, listener] of listeners) webview.removeEventListener(type, listener)
      browserSessions.unregister(id)
      window.pigcodeNative?.browser?.unregister(id)
    }
    // webview 的身份由 id 决定；地址变化只走导航，不重建监听。
  }, [browser.id, browser.threadId])

  const shown = Boolean(slot?.visible && slot.width > 0 && slot.height > 0)
  if (shown && slot) last.current = { width: slot.width, height: slot.height }
  // 空白页、加载失败与崩溃时把槽让给页面区里的状态；webview 仍然挂着，随时可以导航。
  const covered =
    !page.url || page.url === "about:blank" || page.error !== null || page.crashed !== null
  let style: CSSProperties
  let inner: CSSProperties | undefined
  if (shown && slot && viewport) {
    const frame = fitViewport(slot, viewport)
    style = {
      left: slot.x + frame.x,
      top: slot.y + frame.y,
      width: frame.width,
      height: frame.height,
    }
    inner = {
      width: viewport.width,
      height: viewport.height,
      ...(frame.scale < 1 ? { transform: `scale(${frame.scale})`, transformOrigin: "0 0" } : {}),
    }
  } else if (shown && slot) {
    style = { left: slot.x, top: slot.y, width: slot.width, height: slot.height }
  } else {
    const size = viewport ?? last.current
    style = { left: -20000, top: 0, width: size.width, height: size.height }
  }
  const recent = activity ?? null
  return (
    <div
      className="browser-hosted"
      data-browser-id={browser.id}
      data-shown={shown || undefined}
      data-blank={covered || undefined}
      data-agent={recent ? true : undefined}
      data-responsive={viewport ? true : undefined}
      style={style}
    >
      {createElement("webview", {
        ref,
        src,
        partition: PARTITION,
        webpreferences: "contextIsolation=yes,sandbox=yes,backgroundThrottling=no",
        className: "browser-webview",
        style: inner,
      })}
      <BrowserToast id={browser.id} />
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
  onPage,
}: {
  browsers: readonly HostedBrowser[]
  onPage: (browser: HostedBrowser, patch: BrowserTabPatch) => void
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
        <HostedWebview key={browser.id} browser={browser} onPage={onPage} />
      ))}
    </div>,
    document.body,
  )
}

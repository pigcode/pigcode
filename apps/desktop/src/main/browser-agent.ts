/**
 * 内置浏览器的自动化：Host 把 agent 调用的浏览器工具经控制端口发过来，这里在该线程的 webview
 * 里执行。读取页面用注入脚本，点击与键盘用 CDP 输入事件（和真人操作一样触发页面事件），
 * 截图用 capturePage。每个动作都通知渲染进程，右栏的浏览器上会显示 agent 正在做什么。
 */
import { normalizeBrowserUrl } from "./browser-policy"
import {
  formatSnapshot,
  pageFocus,
  pageLocate,
  pageMatches,
  pageScript,
  pageScroll,
  pageSnapshot,
  type ElementTarget,
  type LocatedElement,
  type PageSnapshot,
} from "./browser-page"
import { keyEvents } from "./browser-keys"
import type {
  BrowserActivity,
  BrowserRequest,
  BrowserResponse,
  BrowserResult,
  GuestContents,
} from "./browser-protocol"

export type {
  BrowserActivity,
  BrowserRequest,
  BrowserResponse,
  BrowserResult,
  GuestContents,
} from "./browser-protocol"

/** BrowserAgent 依赖的外部能力。 */
export interface BrowserAgentDeps {
  /** 让渲染进程给线程打开（或切到）浏览器标签；url 为 null 时只把它亮出来。 */
  requestOpen(threadId: string, url: string | null): void
  notifyActivity(activity: BrowserActivity): void
  contentsFor(webContentsId: number): GuestContents | undefined
  /** 等待浏览器标签挂载的上限，测试里调小。 */
  openTimeoutMs?: number
}

interface Session {
  sessionId: string
  threadId: string
  webContentsId: number
}

const SCREENSHOT_WIDTH = 1280
const MAX_EVALUATE = 20_000

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function targetOf(params: Record<string, unknown>): ElementTarget {
  return { ref: text(params.ref), selector: text(params.selector), text: text(params.text) }
}

/** 管理各线程的浏览器会话并执行 agent 的动作。 */
export class BrowserAgent {
  private readonly sessions = new Map<string, Session>()
  /** agent 在每个线程里正在用的会话。 */
  private readonly current = new Map<string, string>()
  private readonly waiters = new Map<string, Array<(session: Session) => void>>()

  constructor(private readonly deps: BrowserAgentDeps) {}

  /** 渲染进程里的 webview 挂好后登记；有动作在等这个线程的浏览器时立即交给它。 */
  register(sessionId: string, threadId: string, webContentsId: number): void {
    const session = { sessionId, threadId, webContentsId }
    this.sessions.set(sessionId, session)
    const waiting = this.waiters.get(threadId)
    if (!waiting) return
    this.waiters.delete(threadId)
    this.current.set(threadId, sessionId)
    for (const resolve of waiting) resolve(session)
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (session && this.current.get(session.threadId) === sessionId) {
      this.current.delete(session.threadId)
    }
  }

  /** 执行一次请求；任何失败都变成给 agent 看的错误文字。 */
  async handle(request: BrowserRequest): Promise<BrowserResponse> {
    try {
      const result = await this.run(request.threadId, request.action, request.params ?? {})
      return { type: "browser.response", id: request.id, ok: true, result }
    } catch (error) {
      return {
        type: "browser.response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private sessionFor(threadId: string): Session | undefined {
    const id = this.current.get(threadId)
    const chosen = id ? this.sessions.get(id) : undefined
    if (chosen) return chosen
    const latest = [...this.sessions.values()].filter((item) => item.threadId === threadId).at(-1)
    if (latest) this.current.set(threadId, latest.sessionId)
    return latest
  }

  private contents(session: Session): GuestContents {
    const guest = this.deps.contentsFor(session.webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.unregister(session.sessionId)
      throw new Error("The browser tab was closed. Call browser_open to open it again.")
    }
    return guest
  }

  /** 线程还没有浏览器时让渲染进程开一个，等它挂载完成。 */
  private async ensure(threadId: string, url: string | null): Promise<Session> {
    const existing = this.sessionFor(threadId)
    this.deps.requestOpen(threadId, existing ? null : url)
    if (existing) return existing
    return withTimeout(
      new Promise<Session>((resolve) => {
        const list = this.waiters.get(threadId) ?? []
        list.push(resolve)
        this.waiters.set(threadId, list)
      }),
      this.deps.openTimeoutMs ?? 15_000,
      "The browser did not open. Is the Pigcode window visible?",
    )
  }

  private require(threadId: string): Session {
    const session = this.sessionFor(threadId)
    if (!session)
      throw new Error("No browser is open for this conversation. Call browser_open first.")
    return session
  }

  private notify(session: Session, action: string, detail: string, point?: LocatedElement): void {
    this.deps.notifyActivity({
      threadId: session.threadId,
      sessionId: session.sessionId,
      action,
      detail,
      ...(point ? { point: { x: point.x, y: point.y } } : {}),
    })
  }

  private async run(
    threadId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<BrowserResult> {
    switch (action) {
      case "open": {
        const url = text(params.url) ? normalizeBrowserUrl(String(params.url)) : null
        if (text(params.url) && !url)
          throw new Error(
            `Cannot open ${String(params.url)}: only http and https pages are allowed.`,
          )
        const fresh = !this.sessionFor(threadId)
        const session = await this.ensure(threadId, url)
        const guest = this.contents(session)
        this.notify(session, "open", url ?? guest.getURL())
        if (url && (!fresh || guest.getURL() !== url)) await this.load(guest, url)
        else await this.settle(guest)
        return { text: this.describe(guest) }
      }
      case "navigate":
        return this.navigate(this.require(threadId), params)
      case "snapshot": {
        const session = this.require(threadId)
        const guest = this.contents(session)
        this.notify(session, "snapshot", guest.getURL())
        return { text: formatSnapshot(await this.snapshot(guest)) }
      }
      case "click":
        return this.click(this.require(threadId), params)
      case "type":
        return this.type(this.require(threadId), params)
      case "press": {
        const session = this.require(threadId)
        const key = text(params.key)
        if (!key) throw new Error("key is required, e.g. Enter or Control+A")
        const guest = this.contents(session)
        this.notify(session, "press", key)
        await this.press(guest, key)
        await this.settle(guest)
        return { text: `Pressed ${key}. ${this.describe(guest)}` }
      }
      case "scroll":
        return this.scroll(this.require(threadId), params)
      case "wait_for":
        return this.waitFor(this.require(threadId), params)
      case "evaluate": {
        const session = this.require(threadId)
        const expression = text(params.expression)
        if (!expression) throw new Error("expression is required")
        const guest = this.contents(session)
        this.notify(session, "evaluate", expression.split("\n")[0] ?? "")
        const value = await withTimeout(
          guest.executeJavaScript(expression, true),
          10_000,
          "The expression did not finish within 10 seconds.",
        )
        const serialized = JSON.stringify(value === undefined ? null : value) ?? "null"
        return {
          text:
            serialized.length > MAX_EVALUATE
              ? `${serialized.slice(0, MAX_EVALUATE)}… (truncated, ${serialized.length} characters)`
              : serialized,
        }
      }
      case "screenshot": {
        const session = this.require(threadId)
        const guest = this.contents(session)
        this.notify(session, "screenshot", guest.getURL())
        return this.screenshot(guest)
      }
      default:
        throw new Error(`Unknown browser action: ${action}`)
    }
  }

  private describe(guest: GuestContents): string {
    const title = guest.getTitle()
    return `Now at ${guest.getURL()}${title ? ` — "${title}"` : ""}.`
  }

  private async load(guest: GuestContents, url: string): Promise<void> {
    try {
      await withTimeout(guest.loadURL(url), 20_000, `Loading ${url} took longer than 20 seconds.`)
    } catch (error) {
      // 页面在加载完成前又跳转了（重定向、脚本跳转）时 Electron 报 ERR_ABORTED，这不算失败。
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("ERR_ABORTED")) throw new Error(`Could not open ${url}: ${message}`)
      await this.settle(guest)
    }
  }

  /** 动作之后稍等：如果引起了导航，等页面加载完（最多 10 秒）。 */
  private async settle(guest: GuestContents): Promise<void> {
    await sleep(250)
    if (!guest.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        guest.removeListener("did-stop-loading", done)
        resolve()
      }, 10_000)
      guest.once("did-stop-loading", done)
    })
  }

  private async navigate(
    session: Session,
    params: Record<string, unknown>,
  ): Promise<BrowserResult> {
    const guest = this.contents(session)
    const action = text(params.action)
    if (action === "back" || action === "forward") {
      const history = guest.navigationHistory
      const can = action === "back" ? history.canGoBack() : history.canGoForward()
      if (!can) return { text: `Cannot go ${action}. ${this.describe(guest)}` }
      this.notify(session, action, "")
      if (action === "back") history.goBack()
      else history.goForward()
      await this.settle(guest)
      return { text: this.describe(guest) }
    }
    if (action === "reload") {
      this.notify(session, "reload", guest.getURL())
      guest.reload()
      await this.settle(guest)
      return { text: `Reloaded. ${this.describe(guest)}` }
    }
    const url = text(params.url) ? normalizeBrowserUrl(String(params.url)) : null
    if (!url) throw new Error("Pass a url, or action back / forward / reload.")
    this.notify(session, "navigate", url)
    await this.load(guest, url)
    return { text: this.describe(guest) }
  }

  private snapshot(guest: GuestContents): Promise<PageSnapshot> {
    return guest.executeJavaScript(
      pageScript(pageSnapshot, { maxElements: 150, maxText: 4000 }),
    ) as Promise<PageSnapshot>
  }

  private async locate(
    guest: GuestContents,
    params: Record<string, unknown>,
  ): Promise<LocatedElement> {
    const target = targetOf(params)
    if (!target.ref && !target.selector && !target.text) {
      throw new Error("Pass ref (from browser_snapshot), selector or text.")
    }
    const located = (await guest.executeJavaScript(
      pageScript(pageLocate, target),
    )) as LocatedElement | null
    if (!located) {
      const what = target.ref ?? target.selector ?? `text "${target.text ?? ""}"`
      throw new Error(`No element matches ${what}. Take a new browser_snapshot and try again.`)
    }
    return located
  }

  private async cdp(guest: GuestContents, method: string, params: object): Promise<unknown> {
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3")
    return guest.debugger.sendCommand(method, params)
  }

  private async click(session: Session, params: Record<string, unknown>): Promise<BrowserResult> {
    const guest = this.contents(session)
    const located = await this.locate(guest, params)
    this.notify(session, "click", located.label, located)
    const clickCount = params.double === true ? 2 : 1
    const base = { x: located.x, y: located.y, button: "left", modifiers: 0 }
    await this.cdp(guest, "Input.dispatchMouseEvent", {
      ...base,
      type: "mouseMoved",
      button: "none",
    })
    for (let count = 1; count <= clickCount; count += 1) {
      await this.cdp(guest, "Input.dispatchMouseEvent", {
        ...base,
        type: "mousePressed",
        clickCount: count,
      })
      await this.cdp(guest, "Input.dispatchMouseEvent", {
        ...base,
        type: "mouseReleased",
        clickCount: count,
      })
    }
    await this.settle(guest)
    return { text: `Clicked ${located.label}. ${this.describe(guest)}` }
  }

  private async type(session: Session, params: Record<string, unknown>): Promise<BrowserResult> {
    const guest = this.contents(session)
    const value = typeof params.text === "string" ? params.text : undefined
    if (value === undefined) throw new Error("text is required")
    const target = targetOf(params)
    const focused = (await guest.executeJavaScript(
      pageScript(pageFocus, {
        ref: target.ref,
        selector: target.selector,
        clear: params.clear === true,
      }),
    )) as string | null
    if (focused === null) {
      throw new Error("No input matches. Take a new browser_snapshot and pass the input's ref.")
    }
    this.notify(session, "type", `${focused}: ${value.slice(0, 40)}`)
    // 直接交给 guest：CDP 的文字输入会落到窗口里有焦点的输入框（比如用户正在写的消息）。
    await guest.insertText(value)
    if (params.submit === true) {
      await this.press(guest, "Enter")
      await this.settle(guest)
    }
    return {
      text: `Typed into ${focused}${params.submit === true ? " and pressed Enter" : ""}. ${this.describe(guest)}`,
    }
  }

  private async press(guest: GuestContents, key: string): Promise<void> {
    for (const event of keyEvents(key)) guest.sendInputEvent(event)
    await sleep(30)
  }

  private async scroll(session: Session, params: Record<string, unknown>): Promise<BrowserResult> {
    const guest = this.contents(session)
    if (text(params.ref) || text(params.selector)) {
      const located = await this.locate(guest, params)
      this.notify(session, "scroll", located.label)
      return { text: `Scrolled ${located.label} into view.` }
    }
    const amount = typeof params.amount === "number" && params.amount > 0 ? params.amount : 1
    const direction = params.direction === "up" ? -1 : 1
    const viewport = (await guest.executeJavaScript("window.innerHeight")) as number
    this.notify(session, "scroll", direction > 0 ? "down" : "up")
    const position = (await guest.executeJavaScript(
      pageScript(pageScroll, { dy: direction * Math.round(viewport * 0.85 * amount) }),
    )) as { y: number; height: number; viewport: number }
    return {
      text: `Scrolled ${direction > 0 ? "down" : "up"} to ${position.y}/${Math.max(0, position.height - position.viewport)}px.`,
    }
  }

  private async waitFor(session: Session, params: Record<string, unknown>): Promise<BrowserResult> {
    const guest = this.contents(session)
    const condition = {
      text: text(params.text),
      selector: text(params.selector),
      url: text(params.url),
    }
    if (!condition.text && !condition.selector && !condition.url) {
      throw new Error("Pass text, selector or url to wait for.")
    }
    const timeout = Math.min(
      typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 10_000,
      30_000,
    )
    this.notify(session, "wait", condition.text ?? condition.selector ?? condition.url ?? "")
    const deadline = Date.now() + timeout
    for (;;) {
      const matched = await guest
        .executeJavaScript(pageScript(pageMatches, condition))
        .catch(() => false)
      if (matched === true) return { text: `Condition met. ${this.describe(guest)}` }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeout} ms waiting for ${JSON.stringify(condition)}.`)
      }
      await sleep(250)
    }
  }

  private async screenshot(guest: GuestContents): Promise<BrowserResult> {
    await this.settle(guest)
    const image = await guest.capturePage()
    if (image.isEmpty()) throw new Error("The page has not rendered anything yet.")
    const size = image.getSize()
    const scaled = size.width > SCREENSHOT_WIDTH ? image.resize({ width: SCREENSHOT_WIDTH }) : image
    const final = scaled.getSize()
    return {
      text: `Screenshot of ${guest.getURL()} (${final.width}×${final.height}).`,
      image: { data: scaled.toJPEG(70).toString("base64"), mimeType: "image/jpeg" },
    }
  }
}

/** main 与 Host 之间内置浏览器动作的消息，以及自动化用到的 webContents 能力。 */
import type { GuestKeyEvent } from "./browser-keys"

/** Host 发来的一次浏览器动作。 */
export interface BrowserRequest {
  type: "browser.request"
  id: number
  threadId: string
  action: string
  params: Record<string, unknown>
}

/** 动作结果：给 agent 的文字，截图时带一张图。 */
export interface BrowserResult {
  text: string
  image?: { data: string; mimeType: string }
}

/** 回给 Host 的响应。 */
export type BrowserResponse =
  | { type: "browser.response"; id: number; ok: true; result: BrowserResult }
  | { type: "browser.response"; id: number; ok: false; error: string }

/** 给渲染进程的活动通知；point 是点击位置（webview 内的 CSS 像素）。 */
export interface BrowserActivity {
  threadId: string
  sessionId: string
  action: string
  detail: string
  point?: { x: number; y: number }
}

/** 自动化用到的 webContents 能力；测试里用替身实现。 */
export interface GuestContents {
  isDestroyed(): boolean
  isLoading(): boolean
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  reload(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  insertText(text: string): Promise<void>
  sendInputEvent(event: GuestKeyEvent): void
  capturePage(): Promise<{
    isEmpty(): boolean
    getSize(): { width: number; height: number }
    resize(options: { width: number }): {
      toJPEG(quality: number): Buffer
      getSize(): { width: number; height: number }
    }
    toJPEG(quality: number): Buffer
  }>
  navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
  }
  debugger: {
    isAttached(): boolean
    attach(version?: string): void
    sendCommand(method: string, params?: object): Promise<unknown>
  }
  once(event: "did-stop-loading", listener: () => void): unknown
  removeListener(event: "did-stop-loading", listener: () => void): unknown
}

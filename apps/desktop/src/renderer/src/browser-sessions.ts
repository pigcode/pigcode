/**
 * 内置浏览器的会话状态。webview 常驻在 BrowserHost 里（切线程、收起右栏都不销毁），
 * 右栏里的浏览器标签只放一个占位槽：槽报告位置，webview 盖到槽上；槽不可见时 webview 移到屏幕外，
 * agent 仍然可以在后台操作它。每个标签还记着响应式视图的尺寸、是否正在选择网页元素和一条短提示。
 */
import { useSyncExternalStore } from "react"
import type { BrowserCrash, BrowserLoadError, BrowserViewport } from "@pigcode/ui-workbench"

/** 页面状态，来自 webview 的导航事件。 */
export interface BrowserPageState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon: string | null
  error: BrowserLoadError | null
  crashed: BrowserCrash | null
}

/** 占位槽在窗口里的位置；visible 为 false 时 webview 移到屏幕外。 */
export interface BrowserSlot {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** agent 最近一次在这个浏览器里的动作。 */
export interface BrowserActivity {
  action: string
  detail: string
  point?: { x: number; y: number } | undefined
  at: number
}

/** 标签上的一条短提示，例如「已加入聊天」。 */
export interface BrowserNotice {
  text: string
  tone: "done" | "warn"
  at: number
}

/** BrowserHost 为每个 webview 注册的操作。 */
export interface BrowserController {
  back(): void
  forward(): void
  reload(): void
  stop(): void
  devtools(): void
  load(url: string): void
  /** 在页面上选择一个元素；按 Esc 或取消时得到 null。 */
  pick(): Promise<unknown>
  cancelPick(): void
}

const EMPTY_PAGE: BrowserPageState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  favicon: null,
  error: null,
  crashed: null,
}

/** agent 动作之后指示亮着的时长。 */
export const ACTIVITY_VISIBLE_MS = 2500
/** 短提示亮着的时长。 */
export const NOTICE_VISIBLE_MS = 2500

const pages = new Map<string, BrowserPageState>()
const slots = new Map<string, BrowserSlot>()
const activities = new Map<string, BrowserActivity>()
const notices = new Map<string, BrowserNotice>()
const viewports = new Map<string, BrowserViewport>()
const picking = new Set<string>()
const controllers = new Map<string, BrowserController>()
const expiries = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 到期后再通知一次，让指示条、落点和短提示消失。 */
function expireLater(key: string, ms: number): void {
  clearTimeout(expiries.get(key))
  expiries.set(
    key,
    setTimeout(() => {
      expiries.delete(key)
      emit()
    }, ms + 50),
  )
}

/** 会话状态的读写入口。 */
export const browserSessions = {
  page: (id: string): BrowserPageState => pages.get(id) ?? EMPTY_PAGE,
  updatePage(id: string, patch: Partial<BrowserPageState>): void {
    pages.set(id, { ...(pages.get(id) ?? EMPTY_PAGE), ...patch })
    emit()
  },
  slot: (id: string): BrowserSlot | undefined => slots.get(id),
  presentSlot(id: string, slot: BrowserSlot | null): void {
    const previous = slots.get(id)
    if (slot === null) {
      if (!previous) return
      slots.delete(id)
    } else {
      if (
        previous &&
        previous.x === slot.x &&
        previous.y === slot.y &&
        previous.width === slot.width &&
        previous.height === slot.height &&
        previous.visible === slot.visible
      ) {
        return
      }
      slots.set(id, slot)
    }
    emit()
  },
  /** 还亮着的 agent 动作；过期后为 undefined。 */
  activity(id: string): BrowserActivity | undefined {
    const activity = activities.get(id)
    return activity && Date.now() - activity.at < ACTIVITY_VISIBLE_MS ? activity : undefined
  },
  setActivity(id: string, activity: BrowserActivity): void {
    activities.set(id, activity)
    expireLater(`activity:${id}`, ACTIVITY_VISIBLE_MS)
    emit()
  },
  /** 还亮着的短提示；过期后为 undefined。 */
  notice(id: string): BrowserNotice | undefined {
    const notice = notices.get(id)
    return notice && Date.now() - notice.at < NOTICE_VISIBLE_MS ? notice : undefined
  },
  setNotice(id: string, text: string, tone: BrowserNotice["tone"] = "done"): void {
    notices.set(id, { text, tone, at: Date.now() })
    expireLater(`notice:${id}`, NOTICE_VISIBLE_MS)
    emit()
  },
  /** 响应式视图的尺寸；没打开时为 undefined。 */
  viewport: (id: string): BrowserViewport | undefined => viewports.get(id),
  setViewport(id: string, viewport: BrowserViewport | null): void {
    if (viewport) viewports.set(id, viewport)
    else viewports.delete(id)
    emit()
  },
  isPicking: (id: string): boolean => picking.has(id),
  setPicking(id: string, on: boolean): void {
    if (on === picking.has(id)) return
    if (on) picking.add(id)
    else picking.delete(id)
    emit()
  },
  register(id: string, controller: BrowserController): void {
    controllers.set(id, controller)
  },
  unregister(id: string): void {
    controllers.delete(id)
    pages.delete(id)
    activities.delete(id)
    notices.delete(id)
    viewports.delete(id)
    picking.delete(id)
    for (const key of [`activity:${id}`, `notice:${id}`]) {
      clearTimeout(expiries.get(key))
      expiries.delete(key)
    }
    emit()
  },
  command(id: string, command: "back" | "forward" | "reload" | "stop" | "devtools"): void {
    controllers.get(id)?.[command]()
  },
  load(id: string, url: string): void {
    controllers.get(id)?.load(url)
  },
  pick(id: string): Promise<unknown> {
    return controllers.get(id)?.pick() ?? Promise.resolve(null)
  },
  cancelPick(id: string): void {
    controllers.get(id)?.cancelPick()
  },
}

/** 订阅全部会话状态的变化；返回值只用来触发重渲染。 */
export function useBrowserVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

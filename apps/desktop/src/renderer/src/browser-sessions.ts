/**
 * 内置浏览器的会话状态。webview 常驻在 BrowserHost 里（切线程、收起右栏都不销毁），
 * 右栏里的浏览器标签只放一个占位槽：槽报告位置，webview 盖到槽上；槽不可见时 webview 移到屏幕外，
 * agent 仍然可以在后台操作它。
 */
import { useSyncExternalStore } from "react"

/** 页面状态，来自 webview 的导航事件。 */
export interface BrowserPageState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
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

/** BrowserHost 为每个 webview 注册的操作。 */
export interface BrowserController {
  back(): void
  forward(): void
  reload(): void
  load(url: string): void
}

const EMPTY_PAGE: BrowserPageState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

/** agent 动作之后指示亮着的时长。 */
export const ACTIVITY_VISIBLE_MS = 2500

const pages = new Map<string, BrowserPageState>()
const slots = new Map<string, BrowserSlot>()
const activities = new Map<string, BrowserActivity>()
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
    clearTimeout(expiries.get(id))
    // 到期后再通知一次，让指示条和落点消失。
    expiries.set(
      id,
      setTimeout(() => {
        expiries.delete(id)
        emit()
      }, ACTIVITY_VISIBLE_MS + 50),
    )
    emit()
  },
  register(id: string, controller: BrowserController): void {
    controllers.set(id, controller)
  },
  unregister(id: string): void {
    controllers.delete(id)
    pages.delete(id)
    activities.delete(id)
    clearTimeout(expiries.get(id))
    expiries.delete(id)
    emit()
  },
  command(id: string, command: "back" | "forward" | "reload"): void {
    controllers.get(id)?.[command]()
  },
  load(id: string, url: string): void {
    controllers.get(id)?.load(url)
  },
}

/** 订阅全部会话状态的变化；返回值只用来触发重渲染。 */
export function useBrowserVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

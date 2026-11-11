/**
 * agent 调用浏览器工具时，main 让界面给它的线程开（或亮出）一个浏览器标签；
 * 如果用户正看着那个线程，顺便展开右栏。
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react"
import { translate, type Locale } from "@pigcode/ui-primitives"
import { EMPTY_SURFACE_STATE, type PanelSurfaceState } from "@pigcode/ui-workbench"

/** 给浏览器标签用的标题：已知 url 时用域名，否则用本地化文案。 */
function browserTitle(url: string | null | undefined, locale: Locale): string {
  if (!url) return translate(locale, "workbench.browser")
  return new URL(url).host
}

export function useBrowserOpen({
  panels,
  keyOf,
  threadId,
  view,
  setPanels,
  onOpenRight,
  locale,
}: {
  /** 按 slot key 保存的面板。 */
  panels: Record<string, PanelSurfaceState>
  /** 会话的面板 key：由草稿建成的会话沿用草稿的 key。 */
  keyOf: (threadId: string) => string
  /** 当前正在看的线程；不是这个线程时只加标签，不动右栏。 */
  threadId: string | null
  view: string
  setPanels: Dispatch<SetStateAction<Record<string, PanelSurfaceState>>>
  /** 展开右栏并把最大化关掉。 */
  onOpenRight: () => void
  locale: Locale
}): void {
  // 事件回调用最新的界面状态，但不必因为状态变化重新订阅。
  const latest = useRef({ panels, keyOf, threadId, view, onOpenRight })
  latest.current = { panels, keyOf, threadId, view, onOpenRight }

  useEffect(
    () =>
      window.pigcodeNative?.browser?.onOpen(({ threadId: target, url }) => {
        const current = latest.current
        const key = current.keyOf(target)
        const existing = current.panels[key]?.surfaces
          .filter((surface) => surface.kind === "browser")
          .at(-1)
        const id = existing?.id ?? `browser-${crypto.randomUUID()}`
        setPanels((all) => {
          const panel = all[key] ?? EMPTY_SURFACE_STATE
          if (panel.surfaces.some((surface) => surface.id === id)) {
            return { ...all, [key]: { ...panel, activeId: id } }
          }
          return {
            ...all,
            [key]: {
              surfaces: [
                ...panel.surfaces,
                {
                  id,
                  kind: "browser",
                  title: browserTitle(url, locale),
                  ...(url ? { url } : {}),
                },
              ],
              activeId: id,
            },
          }
        })
        if (target === current.threadId && current.view === "chat") current.onOpenRight()
      }),
    [locale, setPanels],
  )
}

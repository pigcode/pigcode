/** 浏览器标签里的占位槽：持续报告自己在窗口里的位置，BrowserHost 把 webview 盖上来。 */
import { useLayoutEffect, useRef } from "react"
import { browserSessions } from "./browser-sessions"

export function BrowserSlot({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect()
        // 所在标签或右栏被隐藏时尺寸为 0，webview 随之移到屏幕外。
        const visible = rect.width > 0 && rect.height > 0 && element.offsetParent !== null
        browserSessions.presentSlot(id, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible,
        })
      })
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(element)
    // 侧栏收起、右栏拖宽都会挪动槽的位置而不改变它的尺寸。
    const panel = element.closest(".right-panel")
    if (panel && observer) observer.observe(panel)
    const app = element.closest(".app")
    if (app && observer) observer.observe(app)
    window.addEventListener("resize", measure)
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure)
    // 标签切换通过 hidden 属性隐藏面板；属性变化时重新测量。
    const pane = element.closest(".surface-pane")
    if (pane && mutations)
      mutations.observe(pane, { attributes: true, attributeFilter: ["hidden"] })
    if (app && mutations) {
      mutations.observe(app, { attributes: true, attributeFilter: ["class", "style"] })
    }
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      mutations?.disconnect()
      window.removeEventListener("resize", measure)
      browserSessions.presentSlot(id, null)
    }
  }, [id])
  return <div ref={ref} className="browser-slot" data-browser-slot={id} />
}

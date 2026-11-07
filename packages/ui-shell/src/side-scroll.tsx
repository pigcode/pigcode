/** 侧栏里滚动的部分：上面固定的导航与下面固定的账户行之间，只有这一块滚动。 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

/**
 * 侧栏的列表区。滚动后上沿渐隐，下面还有内容时下沿渐隐；项目展开、Panel 收起或窗口变高时重新判断。
 */
export function SideScroll({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const [fade, setFade] = useState({ top: false, bottom: false })

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return undefined
    const update = (): void => {
      const top = element.scrollTop > 0
      const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1
      setFade((current) =>
        current.top === top && current.bottom === bottom ? current : { top, bottom },
      )
    }
    update()
    element.addEventListener("scroll", update, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    observer?.observe(element)
    if (body.current) observer?.observe(body.current)
    return () => {
      element.removeEventListener("scroll", update)
      observer?.disconnect()
    }
  }, [])

  return (
    <div
      ref={viewport}
      className="side-scroll"
      data-fade-top={fade.top || undefined}
      data-fade-bottom={fade.bottom || undefined}
    >
      <div ref={body} className="side-scroll-body">
        {children}
      </div>
    </div>
  )
}

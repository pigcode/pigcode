/**
 * 对话问题导航（参照 ZCode 的 ConversationTurnNavigator）：会话区左侧一列短横线，每条是一次提问；
 * 当前读到的那条颜色更深，悬停时预览这一问与回答的开头，点击跳到这一轮。会话区窄于 864px
 * 或少于两次提问时不显示（宽度由样式判断）。
 */
import { useEffect, useMemo, useState, type RefObject } from "react"
import { Tooltip, useLocale } from "@pigcode/ui-primitives"
import { isEnded, type TimelineEntry } from "./turns"

interface NavItem {
  key: string
  user: string
  assistant: string | null
  running: boolean
}

/** 去掉 Markdown 记号（代码块、表格分隔行与竖线、标题、列表符号与强调），留一段可读的预览。 */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/[ \t]*\|[ \t]*/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function turnSection(scroller: HTMLElement | null, key: string): HTMLElement | null {
  return (
    scroller?.querySelector<HTMLElement>(`.turn[data-turn="${key.replace(/["\\]/g, "\\$&")}"]`) ??
    null
  )
}

/** 当前读到的那一轮：顶部越过会话区上方三分之一处的最后一轮。 */
function activeIndex(scroller: HTMLElement, keys: readonly string[]): number {
  const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
  let index = 0
  keys.forEach((key, at) => {
    const section = turnSection(scroller, key)
    if (section && section.getBoundingClientRect().top <= top) index = at
  })
  return index
}

/** 渲染问题导航；scroller 是会话的滚动容器。 */
export function TurnNavigator({
  timeline,
  scroller,
}: {
  timeline: readonly TimelineEntry[]
  scroller: RefObject<HTMLElement | null>
}) {
  const { t } = useLocale()
  const items = useMemo<NavItem[]>(
    () =>
      timeline.flatMap((entry) =>
        entry.kind === "turn" && entry.turn.userText
          ? [
              {
                key: entry.turn.key,
                user: entry.turn.userText,
                assistant: entry.turn.answer ? plainPreview(entry.turn.answer) : null,
                running: !isEnded(entry.turn),
              },
            ]
          : [],
      ),
    [timeline],
  )
  const keys = useMemo(() => items.map((item) => item.key), [items])
  const [active, setActive] = useState(0)

  useEffect(() => {
    const element = scroller.current
    if (!element || keys.length < 2) return undefined
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setActive(activeIndex(element, keys)))
    }
    update()
    element.addEventListener("scroll", update, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener("scroll", update)
    }
  }, [scroller, keys])

  if (items.length < 2) return null
  const jump = (key: string) => {
    const section = turnSection(scroller.current, key)
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    section?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" })
  }
  return (
    <nav className="turn-nav" aria-label={t("chat.turnNavigator.label")}>
      <div className="turn-nav-rail">
        {items.map((item, index) => (
          <Tooltip.Root key={item.key}>
            <Tooltip.Trigger
              delay={120}
              closeDelay={80}
              render={
                <button
                  type="button"
                  className="turn-nav-item"
                  aria-current={index === active ? "location" : undefined}
                  aria-label={t("chat.turnNavigator.jumpToQuery").replace(
                    "{index}",
                    String(index + 1),
                  )}
                  data-running={item.running || undefined}
                  onClick={() => jump(item.key)}
                />
              }
            >
              <span className="turn-nav-bar" />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner side="right" align="start" sideOffset={8}>
                <Tooltip.Popup className="turn-nav-card">
                  <p className="turn-nav-user">{plainPreview(item.user)}</p>
                  <p className="turn-nav-assistant" data-empty={item.assistant ? undefined : true}>
                    {item.assistant ??
                      (item.running
                        ? t("chat.turnNavigator.runningAssistant")
                        : t("chat.turnNavigator.emptyAssistant"))}
                  </p>
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </div>
    </nav>
  )
}

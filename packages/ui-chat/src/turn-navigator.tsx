/**
 * 会话导航（参照 Cursor 的 conversation minimap）：会话区左边留白里一列短横线，每条是用户发的一条消息，
 * 当前读到的那条颜色最深。指针靠近时附近几条变长变深；悬停或用键盘聚焦一条时，右边浮出这条消息和回答的开头，
 * 点击或按 ↑↓ 跳到那一条。少于两条消息时不显示；会话区太窄、左边留不出空白时也不显示（宽度由样式判断）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { Tooltip, useLocale } from "@pigcode/ui-primitives"
import { isEnded, type TimelineEntry } from "./turns"

interface NavItem {
  key: string
  user: string
  assistant: string | null
  running: boolean
}

/** 和指针隔着几条以内的短横线会变长。 */
const BUMP_REACH = 4

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

/** 当前读到的那一轮：滚到底时是最后一轮，否则是顶部越过会话区上方三分之一处的最后一轮。 */
function activeIndex(scroller: HTMLElement, keys: readonly string[]): number {
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2) return keys.length - 1
  const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
  let index = 0
  keys.forEach((key, at) => {
    const section = turnSection(scroller, key)
    if (section && section.getBoundingClientRect().top <= top) index = at
  })
  return index
}

function indexOf(target: EventTarget | null): number | null {
  const item = target instanceof Element ? target.closest<HTMLElement>("[data-index]") : null
  return item ? Number(item.dataset.index) : null
}

/** 导航里用键盘聚焦的那一条；点过的那条虽然有焦点，指针离开后不再算。 */
function focusedIndex(rail: HTMLElement): number | null {
  const focused = rail.ownerDocument.activeElement
  if (!focused || !rail.contains(focused) || !focused.matches(":focus-visible")) return null
  return indexOf(focused)
}

/** 按指针或焦点所在的位置（可以是小数）给附近的短横线写上距离，样式按距离把它们加长、加深。 */
function bump(rail: HTMLElement | null, at: number | null): void {
  for (const item of rail?.querySelectorAll<HTMLElement>("[data-index]") ?? []) {
    const distance = at === null ? BUMP_REACH : Math.abs(Number(item.dataset.index) - at)
    if (distance < BUMP_REACH) item.style.setProperty("--turn-nav-distance", distance.toFixed(2))
    else item.style.removeProperty("--turn-nav-distance")
  }
}

/** 指针对着第几条（可以是小数），按第一条的位置和每条的高度算。 */
function pointerIndex(rail: HTMLElement, clientY: number, count: number): number | null {
  const first = rail.querySelector<HTMLElement>("[data-index]")
  if (!first || first.offsetHeight === 0) return null
  const at = (clientY - first.getBoundingClientRect().top) / first.offsetHeight - 0.5
  return Math.min(Math.max(at, 0), count - 1)
}

/** 悬停卡片：这条消息和回答的开头。 */
function TurnPreview({ item }: { item: NavItem }) {
  const { t } = useLocale()
  return (
    <>
      <p className="turn-nav-user">{plainPreview(item.user)}</p>
      <p className="turn-nav-assistant" data-empty={item.assistant ? undefined : true}>
        {item.assistant ??
          (item.running
            ? t("chat.turnNavigator.runningAssistant")
            : t("chat.turnNavigator.emptyAssistant"))}
      </p>
    </>
  )
}

/** 渲染会话导航；scroller 是会话的滚动容器。 */
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
  // 每来一个事件 items 都会重算；只有轮次变了（换会话、发了新消息）才重新订阅滚动。
  const keyList = items.map((item) => item.key).join("\n")
  const keys = useMemo(() => (keyList ? keyList.split("\n") : []), [keyList])
  const [active, setActive] = useState(0)
  const railRef = useRef<HTMLDivElement>(null)
  // 跳过去的那一条在滚动途中、以及滚到头也到不了上方三分之一处时，仍算当前这条；用户再滚就不算了。
  const jumpRef = useRef<{ index: number; top: number; arrived: boolean } | null>(null)

  useEffect(() => {
    jumpRef.current = null
    const element = scroller.current
    if (!element || keys.length < 2) return undefined
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setActive(jumpRef.current?.index ?? activeIndex(element, keys)),
      )
    }
    const onScroll = () => {
      const jump = jumpRef.current
      if (jump && Math.abs(element.scrollTop - jump.top) < 2) jump.arrived = true
      else if (jump?.arrived) jumpRef.current = null
      update()
    }
    const onScrollEnd = () => {
      const jump = jumpRef.current
      if (jump && Math.abs(element.scrollTop - jump.top) >= 2) jumpRef.current = null
      update()
    }
    update()
    element.addEventListener("scroll", onScroll, { passive: true })
    element.addEventListener("scrollend", onScrollEnd)
    return () => {
      cancelAnimationFrame(frame)
      element.removeEventListener("scroll", onScroll)
      element.removeEventListener("scrollend", onScrollEnd)
    }
  }, [scroller, keys])

  // 消息多到一列放不下时，导航自己滚动，让当前那条留在看得见的地方；指针在上面时不动它。
  useEffect(() => {
    const rail = railRef.current
    const item = rail?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!rail || !item || rail.matches(":hover")) return
    const top = item.offsetTop
    if (top < rail.scrollTop || top + item.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = top - (rail.clientHeight - item.offsetHeight) / 2
    }
  }, [active])

  if (items.length < 2) return null

  const jump = (index: number) => {
    const element = scroller.current
    const section = turnSection(element, keys[index] ?? "")
    if (!element || !section) return
    const offset = section.getBoundingClientRect().top - element.getBoundingClientRect().top
    const top = Math.max(
      0,
      Math.min(element.scrollTop + offset, element.scrollHeight - element.clientHeight),
    )
    jumpRef.current = { index, top, arrived: Math.abs(element.scrollTop - top) < 2 }
    setActive(index)
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    element.scrollTo({ top, behavior: reduce ? "auto" : "smooth" })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = indexOf(event.target)
    if (from === null) return
    const to =
      event.key === "ArrowDown"
        ? from + 1
        : event.key === "ArrowUp"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null
    if (to === null || to < 0 || to >= items.length) return
    event.preventDefault()
    railRef.current?.querySelector<HTMLElement>(`[data-index="${to}"]`)?.focus()
    jump(to)
  }

  return (
    <nav className="turn-nav" aria-label={t("chat.turnNavigator.label")}>
      <Tooltip.Root disableHoverablePopup>
        {({ payload }) => {
          const shown = items.find((item) => item.key === payload)
          return (
            <>
              <div
                className="turn-nav-rail"
                ref={railRef}
                onPointerMove={(event) =>
                  bump(
                    railRef.current,
                    pointerIndex(event.currentTarget, event.clientY, items.length),
                  )
                }
                onPointerLeave={(event) => bump(railRef.current, focusedIndex(event.currentTarget))}
                onFocus={(event) => bump(railRef.current, indexOf(event.target))}
                onBlur={(event) => {
                  const rail = event.currentTarget
                  const next = event.relatedTarget
                  if (next instanceof Node && rail.contains(next)) return
                  if (!rail.matches(":hover")) bump(railRef.current, null)
                }}
                onWheel={(event) => {
                  // 导航本身不用滚时，在它上面滚轮照样滚会话。
                  const rail = event.currentTarget
                  if (rail.scrollHeight <= rail.clientHeight) {
                    scroller.current?.scrollBy({ top: event.deltaY })
                  }
                }}
                onKeyDown={onKeyDown}
              >
                {items.map((item, index) => (
                  <Tooltip.Trigger
                    key={item.key}
                    payload={item.key}
                    delay={0}
                    closeDelay={0}
                    closeOnClick={false}
                    render={
                      <button
                        type="button"
                        className="turn-nav-item"
                        data-index={index}
                        tabIndex={index === active ? 0 : -1}
                        aria-current={index === active ? "location" : undefined}
                        aria-label={t("chat.turnNavigator.jumpToQuery").replace(
                          "{index}",
                          String(index + 1),
                        )}
                        onClick={() => jump(index)}
                      />
                    }
                  >
                    <span className="turn-nav-bar" />
                  </Tooltip.Trigger>
                ))}
              </div>
              <Tooltip.Portal>
                <Tooltip.Positioner side="right" align="start" sideOffset={4}>
                  <Tooltip.Popup className="turn-nav-card">
                    {shown ? <TurnPreview item={shown} /> : null}
                  </Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </>
          )
        }}
      </Tooltip.Root>
    </nav>
  )
}

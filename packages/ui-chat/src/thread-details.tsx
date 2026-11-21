/**
 * 会话详情（照 T3 Code 的 ThreadDetailsPanel）：线程头的按钮开关一张卡片。上面是容器给的工作区与版本控制
 * （用哪个应用打开、分支、改动），下面是 agent 列的待办和正在跑的命令、子 agent。会话区放得下时卡片钉在
 * 右上角、默认打开，会话列往左让出位置；放不下时从按钮下面弹出，点别处就收起。
 */
import {
  useId,
  useLayoutEffect,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  SquareMenu,
  SquareTerminal,
} from "lucide-react"
import { Button, Popover, formatDuration, useLocale } from "@pigcode/ui-primitives"
import { elapsed, useNow } from "./duration"
import { toolFamily } from "./tool-identity"
import { commandText } from "./tool-meta"
import type { TodoItem } from "./tool-fields"
import { isEnded, type TimelineEntry } from "./turns"

/** 运行中的一项后台工作：命令或子 agent。 */
export interface RunningWork {
  id: string
  kind: "command" | "agent"
  title: string
  startedAt: string | null
}

/** 最后一个还没结束的轮里正在运行的命令与子 agent。 */
export function runningWorks(timeline: readonly TimelineEntry[]): RunningWork[] {
  const open = [...timeline]
    .reverse()
    .find((entry) => entry.kind === "turn" && !isEnded(entry.turn))
  if (!open || open.kind !== "turn") return []
  const works: RunningWork[] = []
  for (const item of open.turn.work) {
    if (item.kind === "subagent" && item.subagent.status === "running") {
      works.push({
        id: item.subagent.id,
        kind: "agent",
        title: item.subagent.description ?? item.subagent.name,
        startedAt: null,
      })
      continue
    }
    if (item.kind !== "tool") continue
    const tool = item.tool
    if (tool.status !== "running" || toolFamily(tool.name) !== "shell") continue
    works.push({
      id: tool.id,
      kind: "command",
      title: commandText(tool.input) ?? tool.name,
      startedAt: tool.startedAt ?? null,
    })
  }
  return works
}

/** 卡片离会话区上边和右边的距离（tokens.css 的 --details-inset）；浮层由 Base UI 定位，要用数值。 */
const DETAILS_INSET = 12

/**
 * 会话区至少这么宽，卡片才钉在右上角：会话列最窄 640（T3 Code 的 minChatWidth），左边留出会话导航的
 * 48（timeline.css 里这么宽时的 --cv-gutter），右边是卡片 280、离右边 12、离会话列 32（tokens.css 的
 * --details-*）。
 */
const PINNED_MIN_WIDTH = 640 + 48 + 280 + DETAILS_INSET + 32

/** 会话区够不够宽，放得下钉住的卡片。 */
export function usePinnedLayout(view: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const element = view.current
    if (!element) return undefined
    const measure = () => setWide(element.getBoundingClientRect().width >= PINNED_MIN_WIDTH)
    measure()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [view])
  return wide
}

const PINNED_KEY = "pigcode.threadDetails"

/** 钉住的卡片开着没有：默认开着，关掉以后所有会话都记住。 */
export function usePinnedOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(PINNED_KEY) !== "hidden"
    } catch {
      return true
    }
  })
  return [
    open,
    (next) => {
      setOpen(next)
      try {
        if (next) window.localStorage.removeItem(PINNED_KEY)
        else window.localStorage.setItem(PINNED_KEY, "hidden")
      } catch {
        // 存储不可用时只记在这次打开的窗口里。
      }
    },
  ]
}

/**
 * 线程头的开关。钉住时是一个按下态的切换按钮；浮层时是浮层的触发按钮，卡片就弹在它下面、和会话区右边对齐。
 * 卡片收着、待办还没做完时按钮上带着进度，不打开也知道做到哪了。
 */
export function ThreadDetailsToggle({
  pinned,
  open,
  onOpenChange,
  plan,
  anchor,
  children,
}: {
  pinned: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: readonly TodoItem[] | null
  /** 浮层对齐的元素：线程头整行，卡片右边和会话区右边留出同样的 12。 */
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const { t } = useLocale()
  const done = plan?.filter((item) => item.status === "completed").length ?? 0
  const progress = plan && !open && done < plan.length ? `${done}/${plan.length}` : null
  const label = progress
    ? t("chat.details.withProgress")
        .replace("{done}", String(done))
        .replace("{total}", String(plan?.length ?? 0))
    : t("chat.details.title")
  const button: ReactElement = (
    <Button
      variant="plain"
      size="icon"
      type="button"
      className="details-toggle"
      data-progress={progress ? "" : undefined}
      aria-label={label}
      title={label}
      {...(pinned ? { "aria-pressed": open, onClick: () => onOpenChange(!open) } : {})}
    >
      <SquareMenu className="ic" aria-hidden="true" />
      {progress ? (
        <span className="details-toggle-count" aria-hidden="true">
          {progress}
        </span>
      ) : null}
    </Button>
  )
  if (pinned) return button
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={button} />
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="end"
          sideOffset={DETAILS_INSET}
          alignOffset={DETAILS_INSET}
        >
          <Popover.Popup className="details-card" aria-label={t("chat.details.title")}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 钉在会话区右上角的卡片。 */
export function PinnedThreadDetails({ children }: { children: ReactNode }) {
  const { t } = useLocale()
  return (
    <aside className="details-card popup" data-pinned="" aria-label={t("chat.details.title")}>
      {children}
    </aside>
  )
}

/** 卡片里的内容：容器给的工作区与版本控制在上，待办与后台任务在下。 */
export function ThreadDetailsBody({
  workspace,
  plan,
  running,
}: {
  workspace?: ReactNode
  plan: readonly TodoItem[] | null
  running: readonly RunningWork[]
}) {
  const { t } = useLocale()
  const done = plan?.filter((item) => item.status === "completed").length ?? 0
  return (
    <div className="details-body">
      {workspace}
      {plan ? (
        <Section
          title={t("chat.details.todos")}
          meta={
            <span className="details-head-meta" data-done={done >= plan.length || undefined}>
              {done}/{plan.length}
            </span>
          }
        >
          <ul className="details-todos">
            {plan.map((item, index) => (
              <li key={index} className="details-todo" data-status={item.status}>
                <TodoIcon status={item.status} />
                <span className="details-todo-text" title={item.text}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {running.length > 0 ? (
        <Section
          title={t("chat.details.running")}
          meta={<span className="details-head-meta">{running.length}</span>}
        >
          <ul className="details-running">
            {running.map((work) => (
              <RunningRow key={work.id} work={work} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

/** 待办与后台任务各是一段，标题可以折起来。 */
function Section({
  title,
  meta,
  children,
}: {
  title: string
  meta: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const id = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="details-section" aria-labelledby={id}>
      <div className="details-head">
        <button
          type="button"
          className="details-head-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span id={id}>{title}</span>
          <Chevron className="ic ic-xs" aria-hidden="true" />
        </button>
        {meta}
      </div>
      {open ? children : null}
    </section>
  )
}

function TodoIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") return <CheckCircle2 className="ic is-done" aria-hidden="true" />
  if (status === "in-progress") return <ArrowRight className="ic is-current" aria-hidden="true" />
  return <Circle className="ic" aria-hidden="true" />
}

function RunningRow({ work }: { work: RunningWork }) {
  const { locale } = useLocale()
  const now = useNow(work.startedAt !== null)
  const ms = elapsed(work.startedAt, now)
  const Icon = work.kind === "agent" ? Bot : SquareTerminal
  return (
    <li className="details-work" data-kind={work.kind}>
      <Icon className="ic" aria-hidden="true" />
      <span className="details-work-title" title={work.title}>
        {work.title}
      </span>
      {ms === null ? null : <span className="details-work-time">{formatDuration(ms, locale)}</span>}
    </li>
  )
}

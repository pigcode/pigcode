/**
 * 底部终端（参照 ZCode）：聊天区下方可拖动高度的抽屉，可以开多个终端，每个终端一个标签。
 * 标签头左边是「终端」与当前 shell 的名字，中间是标签（以工作目录命名，重名的带序号），
 * 右边是新建终端与关闭面板。切换标签不会关掉其他终端：每个标签的 shell 一直在，只是不显示。
 * shell 自己退出（例如输入 exit）时关掉它的标签；关掉最后一个标签就收起面板，下次打开时再新开一个。
 * 收起面板时只隐藏，shell 会话保留。
 * 新会话草稿里也能打开（参照 ZCode，终端不必依附会话）：终端开在草稿的项目根目录，不建会话；
 * 第一次发送建好会话后，抽屉原样留给这个会话。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { Plus, SquareTerminal, X } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { TerminalSurface, type TerminalOwner, type TerminalSession } from "./terminal-surface"

const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 260
/** 抽屉展开时上方聊天区保留的最小高度，避免窗口变矮后输入区被压没。 */
const MIN_CHAT_HEIGHT = 200

/** 底部终端属性。 */
export interface TerminalDrawerProps {
  connection: Connection
  /** 会话，或者草稿的项目；只决定之后新开的终端挂在哪，已经开着的不受影响。 */
  owner: TerminalOwner
  open: boolean
  onClose: () => void
  /** 页面刷新后从 Host 恢复的已有抽屉终端；非空时直接附着，不另开重复终端。 */
  initialSessions?: readonly TerminalSession[] | undefined
  /** 当前槽位的 terminal.list 恢复查询尚未完成时为 true，暂不自动新开空白终端。 */
  recovering?: boolean | undefined
  /** 标签打开或附着上某个终端时通知上层，防止重复恢复。 */
  onTerminalBound?: ((terminalId: string) => void) | undefined
  /** 标签关闭或退出时通知上层清理恢复记录。 */
  onTerminalClosed?: ((terminalId: string) => void) | undefined
}

/** 一个终端标签：序号在这个抽屉里递增，不复用；shell 起来后记下它的名字与目录。 */
export interface TerminalTab {
  key: string
  index: number
  /** 刷新恢复时要附着的已有终端 id；普通新开标签不带。 */
  attachTerminalId?: string | undefined
  /** 已绑定的真实终端 id。 */
  terminalId?: string | undefined
  shell?: string | undefined
  cwd?: string | undefined
}

/** 抽屉高度不超过聊天区的七成，且为上方消息与输入区预留最小高度。 */
export function clampDrawerHeight(height: number, panelHeight: number): number {
  const max = Math.max(
    MIN_HEIGHT,
    Math.min(Math.round(panelHeight * 0.7), panelHeight - MIN_CHAT_HEIGHT),
  )
  return Math.min(max, Math.max(MIN_HEIGHT, Math.round(height)))
}

/** 路径的最后一段：/Users/me/demo5 → demo5。 */
function folderName(path: string | undefined): string | null {
  const parts = (path ?? "").split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? null
}

/**
 * 标签名：工作目录的名字；同名的标签按打开顺序从第二个起带上序号（demo5、demo5 (2)）。
 * shell 还没起来时用「终端 n」。
 */
export function terminalTitles(tabs: readonly TerminalTab[], fallback: string): string[] {
  const seen = new Map<string, number>()
  return tabs.map((tab) => {
    const base = folderName(tab.cwd) ?? `${fallback} ${tab.index}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count > 1 ? `${base} (${count})` : base
  })
}

export function TerminalDrawer({
  connection,
  owner,
  open,
  onClose,
  initialSessions,
  recovering = false,
  onTerminalBound,
  onTerminalClosed,
}: TerminalDrawerProps) {
  const { t } = useLocale()
  const drawerRef = useRef<HTMLElement>(null)
  const endDrag = useRef<(() => void) | null>(null)
  const [preferredHeight, setPreferredHeight] = useState(DEFAULT_HEIGHT)
  const [panelHeight, setPanelHeight] = useState(0)
  const seenRecovered = useRef<Set<string>>(
    new Set((initialSessions ?? []).map((session) => session.id)),
  )
  // 最近一个标签的序号；只在事件与 effect 里递增，StrictMode 重复调用初始化函数也不会跳号。
  const last = useRef(
    initialSessions && initialSessions.length > 0 ? initialSessions.length : recovering ? 0 : 1,
  )
  const newTab = (): TerminalTab => {
    last.current += 1
    return { key: `tab-${last.current}`, index: last.current }
  }
  const [tabs, setTabs] = useState<TerminalTab[]>(() =>
    initialSessions && initialSessions.length > 0
      ? initialSessions.map((session, i) => ({
          key: `tab-${i + 1}`,
          index: i + 1,
          attachTerminalId: session.id,
          terminalId: session.id,
          shell: session.shell,
          cwd: session.cwd,
        }))
      : recovering
        ? []
        : [{ key: "tab-1", index: 1 }],
  )
  const [activeKey, setActiveKey] = useState("tab-1")
  const list = useRef<HTMLDivElement>(null)

  // 合并恢复的已有终端；仅在抽屉打开、恢复查询完成且当前无标签（也无待合并恢复会话）时才新开空白终端。
  useEffect(() => {
    const incoming = (initialSessions ?? []).filter(
      (session) => !seenRecovered.current.has(session.id),
    )
    if (incoming.length > 0) {
      for (const session of incoming) seenRecovered.current.add(session.id)
      setTabs((current) => {
        const existingIds = new Set(
          current.flatMap((tab) => [tab.attachTerminalId, tab.terminalId].filter(Boolean)),
        )
        const added = incoming
          .filter((session) => !existingIds.has(session.id))
          .map((session) => {
            last.current += 1
            return {
              key: `tab-${last.current}`,
              index: last.current,
              attachTerminalId: session.id,
              terminalId: session.id,
              shell: session.shell,
              cwd: session.cwd,
            }
          })
        if (added.length === 0) return current
        if (current.length === 0) setActiveKey(added[0]!.key)
        return [...current, ...added]
      })
      return
    }
    if (!open || recovering || tabs.length > 0) return
    const tab = newTab()
    setTabs([tab])
    setActiveKey(tab.key)
  }, [open, recovering, tabs.length, initialSessions])

  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null
  const titles = terminalTitles(tabs, t("workbench.terminal"))

  function add(): void {
    const tab = newTab()
    setTabs((current) => [...current, tab])
    setActiveKey(tab.key)
  }

  function close(key: string): void {
    const at = tabs.findIndex((tab) => tab.key === key)
    if (at < 0) return
    const target = tabs[at]
    const closedTerminalId = target?.terminalId ?? target?.attachTerminalId
    if (closedTerminalId) {
      seenRecovered.current.add(closedTerminalId)
      onTerminalClosed?.(closedTerminalId)
    }
    const rest = tabs.filter((tab) => tab.key !== key)
    setTabs(rest)
    if (rest.length === 0) {
      onClose()
      return
    }
    // 关掉的是当前标签时，选中它右边的，没有就选左边的。
    if (key === active?.key) setActiveKey((rest[at] ?? rest[at - 1] ?? rest[0])?.key ?? "")
  }

  function opened(key: string, session: TerminalSession): void {
    seenRecovered.current.add(session.id)
    onTerminalBound?.(session.id)
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key
          ? { ...tab, terminalId: session.id, shell: session.shell, cwd: session.cwd }
          : tab,
      ),
    )
  }

  function select(key: string, focus = false): void {
    setActiveKey(key)
    if (!focus) return
    const button = list.current?.querySelector<HTMLElement>(`[data-terminal-tab="${key}"]`)
    button?.focus()
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    const at = tabs.findIndex((tab) => tab.key === active?.key)
    const target = tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
    if (!target) return
    event.preventDefault()
    select(target.key, true)
  }

  // 监听所在面板高度变化：窗口变矮时临时收紧抽屉高度，变高后无损恢复用户拖好的高度。
  useEffect(() => {
    const panel = drawerRef.current?.closest<HTMLElement>(".panel")
    if (!panel) return undefined
    const sync = (): void => {
      const next = panel.clientHeight
      if (next > 0) setPanelHeight(next)
    }
    sync()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync)
    observer?.observe(panel)
    window.addEventListener("resize", sync)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [open])

  // 拖动过程中组件卸载时清理全局监听和鼠标样式。
  useEffect(() => () => endDrag.current?.(), [])

  const effectiveHeight =
    panelHeight > 0 ? clampDrawerHeight(preferredHeight, panelHeight) : preferredHeight

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    endDrag.current?.()
    const container = event.currentTarget.closest<HTMLElement>(".panel")
    const startY = event.clientY
    const startHeight = effectiveHeight
    const measurePanel = (): number => container?.clientHeight || panelHeight || 800
    const move = (moveEvent: PointerEvent): void => {
      setPreferredHeight(
        clampDrawerHeight(startHeight + startY - moveEvent.clientY, measurePanel()),
      )
    }
    const cancel = (keyEvent: KeyboardEvent | globalThis.KeyboardEvent): void => {
      if (keyEvent.key !== "Escape") return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      setPreferredHeight(startHeight)
      stop()
    }
    const stop = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      window.removeEventListener("keydown", cancel, true)
      document.body.classList.remove("is-resizing-rows")
      endDrag.current = null
    }
    endDrag.current = stop
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    window.addEventListener("keydown", cancel, true)
    document.body.classList.add("is-resizing-rows")
  }

  return (
    <section
      ref={drawerRef}
      className="terminal-drawer"
      hidden={!open}
      aria-label={t("panel.terminalDrawer")}
      style={{ height: effectiveHeight }}
    >
      <div className="terminal-drawer-resizer" aria-hidden="true" onPointerDown={startResize} />
      <header className="terminal-drawer-head">
        <SquareTerminal className="ic ic-sm" aria-hidden="true" />
        <span className="terminal-drawer-title">{t("workbench.terminal")}</span>
        {active?.shell ? <span className="terminal-drawer-shell">{active.shell}</span> : null}
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label={t("panel.terminalTabs")}
          ref={list}
          onKeyDown={onTabKeyDown}
        >
          {tabs.map((tab, at) => {
            const selected = tab.key === active?.key
            const title = titles[at] ?? ""
            return (
              <div
                key={tab.key}
                className="terminal-tab"
                data-active={selected || undefined}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  close(tab.key)
                }}
              >
                <button
                  type="button"
                  role="tab"
                  className="terminal-tab-label"
                  aria-selected={selected}
                  aria-controls={`terminal-pane-${tab.key}`}
                  tabIndex={selected ? 0 : -1}
                  data-terminal-tab={tab.key}
                  title={tab.cwd ?? title}
                  onClick={() => select(tab.key)}
                >
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={t("panel.closeTerminal").replace("{title}", title)}
                  title={t("panel.closeTerminal").replace("{title}", title)}
                  onClick={() => close(tab.key)}
                >
                  <X className="ic ic-xs" aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
        <span className="grow" />
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("terminal.new")}
          title={t("terminal.new")}
          onClick={add}
        >
          <Plus className="ic ic-sm" aria-hidden="true" />
        </Button>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("panel.closeTerminalDrawer")}
          title={t("panel.closeTerminalDrawer")}
          onClick={onClose}
        >
          <X className="ic ic-sm" aria-hidden="true" />
        </Button>
      </header>
      {tabs.map((tab) => {
        const selected = tab.key === active?.key
        return (
          <div
            key={tab.key}
            id={`terminal-pane-${tab.key}`}
            role="tabpanel"
            className="terminal-pane"
            hidden={!selected}
          >
            <TerminalSurface
              connection={connection}
              owner={owner}
              active={open && selected}
              placement="drawer"
              attachTerminalId={tab.attachTerminalId}
              onOpened={(session) => opened(tab.key, session)}
              onExit={() => close(tab.key)}
            />
          </div>
        )
      })}
    </section>
  )
}

/**
 * 底部终端（参照 ZCode）：聊天区下方可拖动高度的抽屉，可以开多个终端，每个终端一个标签。
 * 标签头左边是「终端」与当前 shell 的名字，中间是标签（以工作目录命名，重名的带序号），
 * 右边是新建终端与关闭面板。切换标签不会关掉其他终端：每个标签的 shell 一直在，只是不显示。
 * shell 自己退出（例如输入 exit）时关掉它的标签；关掉最后一个标签就收起面板，下次打开时再新开一个。
 * 收起面板时只隐藏，shell 会话保留。
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
import { TerminalSurface, type TerminalSession } from "./terminal-surface"

const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 260

/** 底部终端属性。 */
export interface TerminalDrawerProps {
  connection: Connection
  threadId: string
  open: boolean
  onClose: () => void
}

/** 一个终端标签：序号在这个抽屉里递增，不复用；shell 起来后记下它的名字与目录。 */
export interface TerminalTab {
  key: string
  index: number
  shell?: string | undefined
  cwd?: string | undefined
}

/** 抽屉高度不超过聊天区的七成，给消息留出空间。 */
function clampHeight(height: number, container: HTMLElement | null): number {
  const max = Math.max(MIN_HEIGHT, Math.round((container?.clientHeight ?? 800) * 0.7))
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

export function TerminalDrawer({ connection, threadId, open, onClose }: TerminalDrawerProps) {
  const { t } = useLocale()
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  // 最近一个标签的序号；只在事件与 effect 里递增，StrictMode 重复调用初始化函数也不会跳号。
  const last = useRef(1)
  const newTab = (): TerminalTab => {
    last.current += 1
    return { key: `tab-${last.current}`, index: last.current }
  }
  const [tabs, setTabs] = useState<TerminalTab[]>([{ key: "tab-1", index: 1 }])
  const [activeKey, setActiveKey] = useState("tab-1")
  const list = useRef<HTMLDivElement>(null)

  // 关掉最后一个标签会收起面板；再打开时新开一个终端。
  useEffect(() => {
    if (!open || tabs.length > 0) return
    const tab = newTab()
    setTabs([tab])
    setActiveKey(tab.key)
  }, [open, tabs.length])

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
    setTabs((current) =>
      current.map((tab) =>
        tab.key === key ? { ...tab, shell: session.shell, cwd: session.cwd } : tab,
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

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const container = event.currentTarget.closest<HTMLElement>(".panel")
    const startY = event.clientY
    const startHeight = height
    const move = (moveEvent: PointerEvent): void => {
      setHeight(clampHeight(startHeight + startY - moveEvent.clientY, container))
    }
    const up = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      document.body.classList.remove("is-resizing-rows")
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    document.body.classList.add("is-resizing-rows")
  }

  return (
    <section
      className="terminal-drawer"
      hidden={!open}
      aria-label={t("panel.terminalDrawer")}
      style={{ height }}
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
              threadId={threadId}
              active={open && selected}
              onOpened={(session) => opened(tab.key, session)}
              onExit={() => close(tab.key)}
            />
          </div>
        )
      })}
    </section>
  )
}

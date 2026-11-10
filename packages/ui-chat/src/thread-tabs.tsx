/**
 * 线程头的标签栏（参照 Cursor）：第一个标签是主会话，后面是这次任务里的子代理，
 * 用来打开主 agent 运行中派生的子代理（只读，展示它的过程与结果）。标签栏不能新建标签；
 * 早先版本由用户添加的子代理会话仍然列出，可以关闭。
 * 子代理标签运行中显示点阵，等待许可时显示一个提示点；主会话标签不显示运行状态。
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { Bot, X } from "lucide-react"
import type { ComposerAgent } from "@pigcode/ui-composer"
import { AgentIcon, StatusDot, useLocale } from "@pigcode/ui-primitives"

/** 标签种类：主会话、早先用户添加的子代理会话、主 agent 派生的子代理。 */
export type ThreadTabKind = "main" | "agent" | "spawned"

/** 标签栏里的一个标签。 */
export interface ThreadTab {
  id: string
  kind: ThreadTabKind
  title: string
  /** 鼠标悬停时显示的完整说明。 */
  description?: string | undefined
  /** 用户添加的子代理所用的 agent；决定标签前的标记。 */
  agentId?: string | null | undefined
  running?: boolean | undefined
  waiting?: boolean | undefined
  closable?: boolean | undefined
}

/** 标签栏属性。 */
export interface ThreadTabsProps {
  tabs: readonly ThreadTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose?: ((id: string) => void) | undefined
  /** Agent 实例；用户添加的子代理标签按它画品牌图标。 */
  agents?: readonly ComposerAgent[] | undefined
}

/** 标题放不下时才在右缘渐隐；放得下时完整显示。 */
function TabTitle({ text, main }: { text: string; main: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return (
    <span
      ref={ref}
      className={main ? "title-text thread-tab-title" : "thread-tab-title"}
      data-overflow={overflow || undefined}
    >
      {text}
    </span>
  )
}

function TabMark({ tab, agents }: { tab: ThreadTab; agents: readonly ComposerAgent[] }) {
  if (tab.kind === "spawned") return <Bot className="ic ic-sm thread-tab-icon" aria-hidden="true" />
  if (tab.kind !== "agent" || !tab.agentId) return null
  // 子代理记的是实例 id；只记了 Agent 时按 Agent 找它的默认实例。
  const item =
    agents.find((entry) => entry.id === tab.agentId) ??
    agents.find((entry) => entry.agentId === tab.agentId)
  return (
    <AgentIcon
      agentId={item?.agentId ?? tab.agentId}
      instanceId={item?.id ?? tab.agentId}
      name={item?.label ?? tab.agentId}
    />
  )
}

/** 渲染标签栏；左右方向键在标签间移动。 */
export function ThreadTabs({ tabs, activeId, onSelect, onClose, agents = [] }: ThreadTabsProps) {
  const { t } = useLocale()
  const list = useRef<HTMLDivElement>(null)

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    const index = tabs.findIndex((tab) => tab.id === activeId)
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
    if (!next) return
    event.preventDefault()
    onSelect(next.id)
    const buttons = list.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []
    for (const button of buttons) if (button.dataset.tabId === next.id) button.focus()
  }

  return (
    <div className="thread-tabs">
      <div
        className="thread-tab-list"
        role="tablist"
        aria-label={t("chat.tabs.label")}
        ref={list}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId
          const status = tab.waiting
            ? t("chat.status.waitingApproval")
            : tab.running
              ? t("chat.status.running")
              : null
          return (
            <div
              key={tab.id}
              className="thread-tab"
              data-kind={tab.kind}
              data-active={active || undefined}
              title={tab.description ?? tab.title}
              onAuxClick={(event) => {
                if (event.button !== 1 || !tab.closable || !onClose) return
                event.preventDefault()
                onClose(tab.id)
              }}
            >
              <button
                type="button"
                role="tab"
                className="thread-tab-label"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-tab-id={tab.id}
                onClick={() => onSelect(tab.id)}
              >
                <TabMark tab={tab} agents={agents} />
                <TabTitle text={tab.title} main={tab.kind === "main"} />
                {tab.kind !== "main" && (tab.waiting || tab.running) ? (
                  <StatusDot
                    tone={tab.waiting ? "warning" : "running"}
                    label={status ?? undefined}
                  />
                ) : null}
              </button>
              {tab.closable && onClose ? (
                <button
                  type="button"
                  className="thread-tab-close"
                  aria-label={`${t("chat.tabs.close")} ${tab.title}`}
                  title={t("chat.tabs.close")}
                  onClick={() => onClose(tab.id)}
                >
                  <X className="ic ic-sm" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

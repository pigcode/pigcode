/**
 * 浮动切换条：左右箭头换方案（键盘 ← → 也行），下拉跳到七块界面里的任意一块、切连接状态，
 * 「重放」把运行中的会话从头再演一遍。它不属于被评估的设计，所以用和界面完全不同的深色胶囊。
 */
import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Moon, RotateCcw, Sun, X } from "lucide-react"
import { VARIANTS, type Place, type UrlState } from "./nav"
import { store } from "./store"

const SHORTCUTS: Array<{ label: string; place: Place }> = [
  { label: "会话列表", place: { screen: "list" } },
  { label: "需要处理", place: { screen: "inbox" } },
  { label: "运行中的会话", place: { screen: "thread", thread: "t-running" } },
  { label: "审批", place: { screen: "thread", thread: "t-approval" } },
  { label: "提问", place: { screen: "thread", thread: "t-question" } },
  { label: "跑完的会话", place: { screen: "thread", thread: "t-unread" } },
  { label: "改动的 diff", place: { screen: "diff", thread: "t-unread" } },
  { label: "新会话", place: { screen: "new" } },
  { label: "电脑和连接", place: { screen: "computer" } },
  { label: "配对", place: { screen: "pair" } },
]

function shortcutIndex(state: UrlState): number {
  return SHORTCUTS.findIndex(
    (item) => item.place.screen === state.screen && (item.place.thread === undefined || item.place.thread === state.thread),
  )
}

export function Switcher({
  state,
  update,
  onHide,
}: {
  state: UrlState
  update: (patch: Partial<UrlState>, push?: boolean) => void
  onHide?: (() => void) | undefined
}) {
  const index = VARIANTS.findIndex((item) => item.key === state.variant)
  const variant = VARIANTS[index] ?? VARIANTS[0]!
  const cycle = (step: number) => update({ variant: VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key })
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark")

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return
      if (event.key === "ArrowLeft") cycle(-1)
      if (event.key === "ArrowRight") cycle(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark")
  }, [state.theme])

  const shortcut = shortcutIndex(state)

  return (
    <div className="proto-switcher" role="toolbar" aria-label="原型切换条">
      <button type="button" aria-label="上一套方案" onClick={() => cycle(-1)}>
        <ChevronLeft className="ic" aria-hidden="true" />
      </button>
      <span className="proto-variant">
        {variant.key} <span className="proto-variant-name">{variant.name}</span>
      </span>
      <button type="button" aria-label="下一套方案" onClick={() => cycle(1)}>
        <ChevronRight className="ic" aria-hidden="true" />
      </button>
      <select
        aria-label="跳到界面"
        value={shortcut < 0 ? "" : String(shortcut)}
        onChange={(event) => {
          const item = SHORTCUTS[Number(event.target.value)]
          if (item) update({ screen: item.place.screen, thread: item.place.thread, file: undefined, project: undefined }, true)
        }}
      >
        {shortcut < 0 ? <option value="">（当前界面）</option> : null}
        {SHORTCUTS.map((item, at) => (
          <option key={item.label} value={String(at)}>
            {item.label}
          </option>
        ))}
      </select>
      <select aria-label="连接状态" value={state.conn} onChange={(event) => update({ conn: event.target.value as UrlState["conn"] })}>
        <option value="online">在线</option>
        <option value="reconnecting">重连中</option>
        <option value="offline">离线</option>
      </select>
      <button type="button" aria-label="重放运行中的会话" title="重放运行中的会话" onClick={() => store.replay()}>
        <RotateCcw className="ic" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={dark ? "换成浅色" : "换成深色"}
        title={dark ? "换成浅色" : "换成深色"}
        onClick={() => update({ theme: dark ? "light" : "dark" })}
      >
        {dark ? <Sun className="ic" aria-hidden="true" /> : <Moon className="ic" aria-hidden="true" />}
      </button>
      {onHide ? (
        <button type="button" aria-label="收起切换条" title="收起切换条" onClick={onHide}>
          <X className="ic" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

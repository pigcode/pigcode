/**
 * 右侧面板：多标签的 surface（浏览器、终端、文件、Diff、PR、检查点，以及插件注册的标签）、
 * 添加菜单与空状态启动器。插件标签和内置标签用同一套标签栏与外框。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  FileDiff,
  Files,
  Globe,
  GitPullRequest,
  History,
  Plus,
  Puzzle,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react"
import { FileIcon, Menu } from "@pigcode/ui-primitives"
import {
  SURFACE_KINDS,
  SURFACE_SHORTCUTS,
  type PanelSurface,
  type PanelSurfaceKind,
  type PluginSurfaceOption,
  type SurfaceKind,
} from "./surface-state"

export * from "./surface-state"

const SURFACE_ICONS: Record<SurfaceKind, LucideIcon> = {
  browser: Globe,
  terminal: SquareTerminal,
  files: Files,
  diff: FileDiff,
  pr: GitPullRequest,
  checkpoint: History,
}

/** 右侧面板文案；容器按 locale 注入，组件本身不依赖 locale。 */
export interface RightPanelLabels {
  panel: string
  tabs: string
  launcher: string
  add: string
  close: string
  /** 启动器与菜单里插件标签那一组的标题。 */
  plugins: string
  surfaces: Record<SurfaceKind, string>
}

/** 默认中文文案。 */
export const DEFAULT_RIGHT_PANEL_LABELS: RightPanelLabels = {
  panel: "右侧面板",
  tabs: "面板标签",
  launcher: "打开一个面板",
  add: "添加面板",
  close: "关闭",
  plugins: "插件",
  surfaces: {
    browser: "浏览器",
    terminal: "终端",
    files: "文件",
    diff: "Diff",
    pr: "PR",
    checkpoint: "检查点",
  },
}

/** 右侧面板属性；标签内容由容器渲染为 children，以便终端与浏览器在切换标签时保持挂载。 */
export interface RightPanelProps {
  threadId: string
  surfaces: readonly PanelSurface[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onAdd: (kind: SurfaceKind) => void
  /** 暂不可用的种类及原因；在启动器和菜单里置灰。 */
  unavailable?: Partial<Record<SurfaceKind, string>>
  /** 插件注册的标签；列在启动器与菜单的「插件」组里。 */
  plugins?: readonly PluginSurfaceOption[]
  onAddPlugin?: ((id: string) => void) | undefined
  /** 标签栏右侧的布局按钮（最大化、底部终端、收起面板）。 */
  controls?: ReactNode
  labels?: Partial<Omit<RightPanelLabels, "surfaces">> & {
    surfaces?: Partial<Record<SurfaceKind, string>>
  }
  children?: ReactNode
}

/** 弹层打开时不响应启动器快捷键，避免和菜单、对话框的键盘操作冲突。 */
const BLOCKING_LAYERS = ".menu-popup, [role='dialog'], .palette"

/** 焦点在可输入元素里时不拦截单键快捷键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  )
}

/** 按键是否是某个可用 surface 的快捷键。 */
function shortcutKind(
  event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">,
  available: readonly SurfaceKind[],
): SurfaceKind | null {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null
  const key = event.key.toUpperCase()
  return available.find((kind) => SURFACE_SHORTCUTS[kind] === key) ?? null
}

function SurfaceIcon({ kind, title }: { kind: PanelSurfaceKind; title?: string }) {
  if (kind === "file") return <FileIcon name={title ?? ""} kind="file" />
  const Icon = kind === "plugin" ? Puzzle : SURFACE_ICONS[kind]
  return <Icon className="ic ic-sm" aria-hidden="true" />
}

/** 启动器里插件标签那一组；没有插件标签时不显示。 */
function PluginLauncherGroup({
  labels,
  plugins,
  onAddPlugin,
}: {
  labels: RightPanelLabels
  plugins: readonly PluginSurfaceOption[]
  onAddPlugin: ((id: string) => void) | undefined
}) {
  if (plugins.length === 0 || !onAddPlugin) return null
  return (
    <>
      <h4 className="surface-launcher-group">{labels.plugins}</h4>
      <div className="surface-launcher-list">
        {plugins.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            className="surface-launcher-item"
            title={plugin.description}
            onClick={() => onAddPlugin(plugin.id)}
          >
            <SurfaceIcon kind="plugin" />
            <span className="grow truncate">{plugin.title}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** 空面板：列出可以打开的 surface；面板显示时单键即可打开，方向键在列表里移动。 */
function SurfaceLauncher({
  labels,
  unavailable,
  onAdd,
  plugins,
  onAddPlugin,
}: {
  labels: RightPanelLabels
  unavailable: Partial<Record<SurfaceKind, string>>
  onAdd: (kind: SurfaceKind) => void
  plugins: readonly PluginSurfaceOption[]
  onAddPlugin: ((id: string) => void) | undefined
}) {
  const available = SURFACE_KINDS.filter((kind) => unavailable[kind] === undefined)
  const [highlight, setHighlight] = useState(-1)
  const root = useRef<HTMLDivElement | null>(null)
  const latest = useRef({ available, onAdd })
  latest.current = { available, onAdd }

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      // 面板收起时外壳只是隐藏它，启动器仍然挂载。
      if (!root.current || root.current.closest("[hidden]")) return
      if (document.querySelector(BLOCKING_LAYERS)) return
      const kind = shortcutKind(event, latest.current.available)
      if (!kind) return
      event.preventDefault()
      latest.current.onAdd(kind)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (available.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((current) => (current + 1) % available.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((current) => (current <= 0 ? available.length - 1 : current - 1))
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      const kind = available[highlight]
      if (!kind) return
      event.preventDefault()
      onAdd(kind)
    }
  }

  return (
    <div
      ref={root}
      className="surface-launcher"
      tabIndex={0}
      aria-label={labels.launcher}
      onKeyDown={onListKeyDown}
    >
      <div className="surface-launcher-inner">
        <h3>{labels.launcher}</h3>
        <div className="surface-launcher-list">
          {SURFACE_KINDS.map((kind) => {
            const reason = unavailable[kind]
            const highlighted = available[highlight] === kind
            return (
              <button
                key={kind}
                type="button"
                className="surface-launcher-item"
                data-highlighted={highlighted || undefined}
                disabled={reason !== undefined}
                title={reason}
                aria-keyshortcuts={SURFACE_SHORTCUTS[kind]}
                onMouseEnter={() => setHighlight(available.indexOf(kind))}
                onClick={() => onAdd(kind)}
              >
                <SurfaceIcon kind={kind} />
                <span className="grow truncate">{labels.surfaces[kind]}</span>
                <kbd aria-hidden="true">{SURFACE_SHORTCUTS[kind]}</kbd>
              </button>
            )
          })}
        </div>
        <PluginLauncherGroup labels={labels} plugins={plugins} onAddPlugin={onAddPlugin} />
      </div>
    </div>
  )
}

/** 标签栏末尾的「+」：菜单打开时同样支持单键选择；插件标签列在分隔线下面。 */
function AddSurfaceMenu({
  labels,
  unavailable,
  onAdd,
  plugins,
  onAddPlugin,
}: {
  labels: RightPanelLabels
  unavailable: Partial<Record<SurfaceKind, string>>
  onAdd: (kind: SurfaceKind) => void
  plugins: readonly PluginSurfaceOption[]
  onAddPlugin: ((id: string) => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const available = SURFACE_KINDS.filter((kind) => unavailable[kind] === undefined)

  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    const kind = shortcutKind(event.nativeEvent, available)
    if (!kind) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    onAdd(kind)
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className="icon-btn surface-add"
        type="button"
        aria-label={labels.add}
        title={labels.add}
      >
        <Plus className="ic ic-sm" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="menu-popup surface-menu" onKeyDownCapture={onKeyDownCapture}>
            {SURFACE_KINDS.map((kind) => (
              <Menu.Item
                key={kind}
                className="menu-item"
                disabled={unavailable[kind] !== undefined}
                aria-keyshortcuts={SURFACE_SHORTCUTS[kind]}
                onClick={() => onAdd(kind)}
              >
                <SurfaceIcon kind={kind} />
                <span className="grow">{labels.surfaces[kind]}</span>
                <kbd className="menu-kbd" aria-hidden="true">
                  {SURFACE_SHORTCUTS[kind]}
                </kbd>
              </Menu.Item>
            ))}
            {plugins.length > 0 && onAddPlugin ? (
              <>
                <Menu.Separator className="menu-sep" />
                <Menu.Group>
                  <Menu.Label className="menu-label">{labels.plugins}</Menu.Label>
                  {plugins.map((plugin) => (
                    <Menu.Item
                      key={plugin.id}
                      className="menu-item"
                      onClick={() => onAddPlugin(plugin.id)}
                    >
                      <SurfaceIcon kind="plugin" />
                      <span className="grow">{plugin.title}</span>
                    </Menu.Item>
                  ))}
                </Menu.Group>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** 右侧面板；标签与激活状态完全受控。 */
export function RightPanel({
  threadId,
  surfaces,
  activeId,
  onActivate,
  onClose,
  onAdd,
  unavailable = {},
  plugins = [],
  onAddPlugin,
  controls,
  labels: overrides,
  children,
}: RightPanelProps) {
  const labels: RightPanelLabels = {
    ...DEFAULT_RIGHT_PANEL_LABELS,
    ...overrides,
    surfaces: { ...DEFAULT_RIGHT_PANEL_LABELS.surfaces, ...overrides?.surfaces },
  }
  const tablist = useRef<HTMLDivElement | null>(null)
  const activeTitle = surfaces.find((surface) => surface.id === activeId)?.title

  // 标签多到需要横向滚动时，保证当前标签可见；标题变长（浏览器换成主机名）也要重新滚动。
  useEffect(() => {
    if (!activeId) return
    const tab = Array.from(tablist.current?.children ?? []).find((element) =>
      element.querySelector(`[id="surface-tab-${activeId}"]`),
    )
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [activeId, activeTitle, surfaces.length])

  return (
    <aside className="right-panel" aria-label={labels.panel} data-thread-id={threadId}>
      <div className="right-panel-bar">
        <div className="surface-tabs" role="tablist" aria-label={labels.tabs} ref={tablist}>
          {surfaces.map((surface) => {
            const active = surface.id === activeId
            return (
              <div
                key={surface.id}
                className="surface-tab"
                data-active={active || undefined}
                data-kind={surface.kind}
                role="presentation"
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  onClose(surface.id)
                }}
              >
                <button
                  type="button"
                  className="surface-tab-close"
                  aria-label={`${labels.close} ${surface.title}`}
                  title={`${labels.close} ${surface.title}`}
                  onClick={() => onClose(surface.id)}
                >
                  <span className="surface-tab-icon">
                    <SurfaceIcon kind={surface.kind} title={surface.title} />
                  </span>
                  <X className="ic ic-sm surface-tab-x" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  role="tab"
                  id={`surface-tab-${surface.id}`}
                  className="surface-tab-label"
                  aria-selected={active}
                  aria-controls="right-panel-body"
                  onClick={() => onActivate(surface.id)}
                >
                  <span className="truncate">{surface.title}</span>
                  {surface.dirty ? <span className="surface-tab-dirty" aria-hidden="true" /> : null}
                </button>
              </div>
            )
          })}
        </div>
        <AddSurfaceMenu
          labels={labels}
          unavailable={unavailable}
          onAdd={onAdd}
          plugins={plugins}
          onAddPlugin={onAddPlugin}
        />
        <span className="right-panel-drag" />
        {controls}
      </div>
      <div
        className="right-panel-body"
        id="right-panel-body"
        role="tabpanel"
        {...(activeId ? { "aria-labelledby": `surface-tab-${activeId}` } : {})}
      >
        {activeId === null ? (
          <SurfaceLauncher
            labels={labels}
            unavailable={unavailable}
            onAdd={onAdd}
            plugins={plugins}
            onAddPlugin={onAddPlugin}
          />
        ) : null}
        {children}
      </div>
    </aside>
  )
}

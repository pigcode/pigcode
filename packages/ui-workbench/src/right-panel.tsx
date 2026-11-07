/**
 * 右侧面板（Workbench）：多标签的 Surface、添加菜单与空状态启动器。启动器与菜单按 Surface 扩展点上
 * 登记的内容生成：内置 Surface 在前，插件的 Surface 在「插件」组里；插件标签和内置标签用同一套标签栏与外框。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Plus, Puzzle, X } from "lucide-react"
import {
  contributionText,
  useContributions,
  type SurfaceContribution,
} from "@pigcode/client-runtime"
import { FileIcon, Menu, useLocale } from "@pigcode/ui-primitives"
import { FILE_SURFACE_KIND, type PanelSurface } from "./surface-state"

export * from "./surface-state"

/** 右侧面板各部分用到的文案。 */
interface RightPanelLabels {
  panel: string
  tabs: string
  launcher: string
  add: string
  close: string
  /** 启动器与菜单里插件 Surface 那一组的标题。 */
  plugins: string
}

function useRightPanelLabels(): RightPanelLabels {
  const { t } = useLocale()
  return {
    panel: t("panel.label"),
    tabs: t("panel.tabs"),
    launcher: t("panel.launcher"),
    add: t("panel.add"),
    close: t("panel.close"),
    plugins: t("panel.plugins"),
  }
}

/** 启动器与菜单里的一项：Surface 与它当前的名称、说明和不可用原因。 */
interface SurfaceOption {
  surface: SurfaceContribution
  name: string
  description: string | undefined
  reason: string | undefined
}

/** 把 Surface 扩展点的内容分成内置与插件两组，文字换成当前语言。 */
function useSurfaceOptions(): { builtin: SurfaceOption[]; plugins: SurfaceOption[] } {
  const { t } = useLocale()
  const options = useContributions("surface").map((surface) => {
    const reason = surface.unavailable?.()
    return {
      surface,
      name: contributionText(t, surface.title),
      description: surface.description ? contributionText(t, surface.description) : undefined,
      reason: reason ? t(reason) : undefined,
    }
  })
  return {
    builtin: options.filter((option) => option.surface.owner.kind === "builtin"),
    plugins: options.filter((option) => option.surface.owner.kind === "plugin"),
  }
}

/** 右侧面板属性；标签内容由容器渲染为 children，以便终端与浏览器在切换标签时保持挂载。 */
export interface RightPanelProps {
  threadId: string
  surfaces: readonly PanelSurface[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** 打开一个 Surface；参数是它在扩展点上的 id。 */
  onAdd: (kind: string) => void
  /** 标签栏右侧的布局按钮（最大化、底部终端、收起面板）。 */
  controls?: ReactNode
  children?: ReactNode
}

/** 菜单、下拉、对话框打开时不响应启动器快捷键，避免和它们的键盘操作冲突；输入框上方的建议列表不算。 */
const BLOCKING_LAYERS = ".menu-positioner, [role='dialog']"

/** 焦点在可输入元素里时不拦截单键快捷键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  )
}

/** 按键是否是某个可用 Surface 的快捷键。 */
function shortcutSurface(
  event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">,
  available: readonly SurfaceOption[],
): string | null {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null
  const key = event.key.toUpperCase()
  return available.find((option) => option.surface.shortcut === key)?.surface.id ?? null
}

/** Surface 的图标：用它登记的图标；已经注销（标签还没关掉）时用拼图。 */
function SurfaceIcon({ surface }: { surface: SurfaceContribution | undefined }) {
  const Icon = surface?.icon ?? Puzzle
  return <Icon className="ic ic-sm" aria-hidden="true" />
}

/** 标签的图标；文件标签按文件类型，浏览器标签用网站图标，读不到时退回 Surface 的图标。 */
function TabIcon({
  tab,
  surface,
}: {
  tab: PanelSurface
  surface: SurfaceContribution | undefined
}) {
  const [broken, setBroken] = useState<string | null>(null)
  if (tab.kind === FILE_SURFACE_KIND) return <FileIcon name={tab.title} kind="file" />
  if (tab.icon && broken !== tab.icon) {
    return (
      <img
        className="surface-tab-favicon"
        src={tab.icon}
        alt=""
        draggable={false}
        onError={() => setBroken(tab.icon ?? null)}
      />
    )
  }
  return <SurfaceIcon surface={surface} />
}

/** 启动器里插件 Surface 那一组；没有插件 Surface 时不显示。 */
function PluginLauncherGroup({
  labels,
  plugins,
  onAdd,
}: {
  labels: RightPanelLabels
  plugins: readonly SurfaceOption[]
  onAdd: (kind: string) => void
}) {
  if (plugins.length === 0) return null
  return (
    <>
      <h4 className="surface-launcher-group">{labels.plugins}</h4>
      <div className="surface-launcher-list">
        {plugins.map((option) => (
          <button
            key={option.surface.id}
            type="button"
            className="surface-launcher-item"
            title={option.reason ?? option.description}
            disabled={option.reason !== undefined}
            onClick={() => onAdd(option.surface.id)}
          >
            <SurfaceIcon surface={option.surface} />
            <span className="grow truncate">{option.name}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** 空面板：列出可以打开的 Surface；面板显示时单键即可打开，方向键在内置 Surface 里移动。 */
function SurfaceLauncher({
  labels,
  builtin,
  plugins,
  onAdd,
}: {
  labels: RightPanelLabels
  builtin: readonly SurfaceOption[]
  plugins: readonly SurfaceOption[]
  onAdd: (kind: string) => void
}) {
  const available = builtin.filter((option) => option.reason === undefined)
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
      const kind = shortcutSurface(event, latest.current.available)
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
      const option = available[highlight]
      if (!option) return
      event.preventDefault()
      onAdd(option.surface.id)
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
          {builtin.map((option) => {
            const { surface, reason } = option
            const highlighted = available[highlight] === option
            return (
              <button
                key={surface.id}
                type="button"
                className="surface-launcher-item"
                data-highlighted={highlighted || undefined}
                disabled={reason !== undefined}
                title={reason}
                aria-keyshortcuts={surface.shortcut}
                onMouseEnter={() => setHighlight(available.indexOf(option))}
                onClick={() => onAdd(surface.id)}
              >
                <SurfaceIcon surface={surface} />
                <span className="grow truncate">{option.name}</span>
                {surface.shortcut ? <kbd aria-hidden="true">{surface.shortcut}</kbd> : null}
              </button>
            )
          })}
        </div>
        <PluginLauncherGroup labels={labels} plugins={plugins} onAdd={onAdd} />
      </div>
    </div>
  )
}

/** 标签栏末尾的「+」：菜单打开时同样支持单键选择；插件的 Surface 列在分隔线下面。 */
function AddSurfaceMenu({
  labels,
  builtin,
  plugins,
  onAdd,
}: {
  labels: RightPanelLabels
  builtin: readonly SurfaceOption[]
  plugins: readonly SurfaceOption[]
  onAdd: (kind: string) => void
}) {
  const [open, setOpen] = useState(false)
  const available = builtin.filter((option) => option.reason === undefined)

  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    const kind = shortcutSurface(event.nativeEvent, available)
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
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="surface-menu" onKeyDownCapture={onKeyDownCapture}>
            {builtin.map(({ surface, name, reason }) => (
              <Menu.Item
                key={surface.id}
                disabled={reason !== undefined}
                aria-keyshortcuts={surface.shortcut}
                onClick={() => onAdd(surface.id)}
              >
                <SurfaceIcon surface={surface} />
                <span className="grow">{name}</span>
                {surface.shortcut ? (
                  <kbd className="menu-meta" aria-hidden="true">
                    {surface.shortcut}
                  </kbd>
                ) : null}
              </Menu.Item>
            ))}
            {plugins.length > 0 ? (
              <>
                <Menu.Separator />
                <Menu.Group>
                  <Menu.Label>{labels.plugins}</Menu.Label>
                  {plugins.map(({ surface, name, reason }) => (
                    <Menu.Item
                      key={surface.id}
                      disabled={reason !== undefined}
                      onClick={() => onAdd(surface.id)}
                    >
                      <SurfaceIcon surface={surface} />
                      <span className="grow">{name}</span>
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
  controls,
  children,
}: RightPanelProps) {
  const labels = useRightPanelLabels()
  const { builtin, plugins } = useSurfaceOptions()
  const contributions = useContributions("surface")
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
                    <TabIcon
                      tab={surface}
                      surface={contributions.find((item) => item.id === surface.kind)}
                    />
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
        <AddSurfaceMenu labels={labels} builtin={builtin} plugins={plugins} onAdd={onAdd} />
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
          <SurfaceLauncher labels={labels} builtin={builtin} plugins={plugins} onAdd={onAdd} />
        ) : null}
        {children}
      </div>
    </aside>
  )
}

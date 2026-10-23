/** 命令面板：会话切换、主操作与快捷键入口。 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { formatShortcut, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

/** 命令面板中的一条可执行项。 */
export interface PaletteItem {
  id: string
  group: "actions" | "threads" | "projects"
  label: string
  hint?: string
  icon: string
  keywords?: string
  run: () => void
}

/** 命令面板属性；所有动作由 Shell 注入。 */
export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  threads: Thread[]
  projects: Project[]
  activeThreadId: string | null
  onNewThread: () => void
  onOpenThread: (threadId: string) => void
  onAddProject: () => void
  onSettings: () => void
  onPlugins: () => void
  onToggleSidebar?: () => void
  onToggleWorkbench?: () => void
}

/** 行动项固定顺序；会话和项目按最近使用排在后面。 */
function actionItems(t: (key: MessageKey) => string, props: CommandPaletteProps): PaletteItem[] {
  return [
    {
      id: "new-thread",
      group: "actions",
      label: t("nav.newThread"),
      hint: formatShortcut("Mod+n"),
      icon: "plus",
      keywords: "new chat session 新会话",
      run: props.onNewThread,
    },
    ...(props.onToggleSidebar
      ? [
          {
            id: "toggle-sidebar",
            group: "actions" as const,
            label: t("palette.toggleSidebar"),
            hint: formatShortcut("Mod+b"),
            icon: "sidebar",
            keywords: "sidebar 侧栏",
            run: props.onToggleSidebar,
          },
        ]
      : []),
    ...(props.onToggleWorkbench
      ? [
          {
            id: "toggle-workbench",
            group: "actions" as const,
            label: t("palette.toggleWorkbench"),
            hint: formatShortcut("Mod+j"),
            icon: "tray",
            keywords: "workbench panel 工作台",
            run: props.onToggleWorkbench,
          },
        ]
      : []),
    {
      id: "settings",
      group: "actions",
      label: t("settings.title"),
      hint: formatShortcut("Mod+,"),
      icon: "gear",
      keywords: "settings preferences 设置",
      run: props.onSettings,
    },
    {
      id: "plugins",
      group: "actions",
      label: t("settings.plugins"),
      icon: "cube",
      keywords: "plugins extensions 插件",
      run: props.onPlugins,
    },
    {
      id: "add-project",
      group: "actions",
      label: t("nav.addProject"),
      icon: "folder-plus",
      keywords: "add project folder 项目",
      run: props.onAddProject,
    },
  ]
}

/** 渲染居中的命令面板；↑↓ 移动，回车执行，Esc 关闭。 */
export function CommandPalette(props: CommandPaletteProps) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo<PaletteItem[]>(() => {
    // 与侧栏一致：已归档的会话和已从侧栏移除的项目里的会话都不列出。
    const known = new Set(props.projects.map((project) => project.id))
    const threads = props.threads
      .filter((thread) => thread.archivedAt === null && known.has(thread.projectId))
      .map((thread) => ({
        id: `thread-${thread.id}`,
        group: "threads" as const,
        label: thread.title,
        hint: thread.defaultProviderId,
        icon: "chat",
        keywords: `${thread.title} ${thread.defaultProviderId}`,
        run: () => props.onOpenThread(thread.id),
      }))
    const projects = props.projects.map((project) => ({
      id: `project-${project.id}`,
      group: "projects" as const,
      label: project.name,
      hint: project.rootPath,
      icon: "folder",
      keywords: `${project.name} ${project.rootPath}`,
      run: props.onNewThread,
    }))
    return [...actionItems(t, props), ...threads, ...projects]
  }, [props, t])

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? items.filter((item) => `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(needle))
    : items
  const current = visible[Math.min(active, Math.max(0, visible.length - 1))]

  useEffect(() => {
    if (!props.open) return
    setQuery("")
    setActive(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [props.open])

  useEffect(() => {
    if (!props.open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault()
        props.onClose()
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActive((value) => (visible.length === 0 ? 0 : (value + 1) % visible.length))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive((value) =>
          visible.length === 0 ? 0 : (value - 1 + visible.length) % visible.length,
        )
        return
      }
      if (event.key === "Enter" && current) {
        event.preventDefault()
        current.run()
        props.onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [props.open, props.onClose, current, visible.length])

  if (!props.open) return null

  const groupTitles: Record<PaletteItem["group"], string> = {
    actions: t("palette.actions"),
    threads: t("palette.threads"),
    projects: t("palette.projects"),
  }
  let lastGroup: PaletteItem["group"] | null = null

  return (
    <div
      className="palette-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("palette.actions")}>
        <div className="palette-search">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" role="listbox" aria-label={t("palette.actions")}>
          {visible.length === 0 ? (
            <p className="palette-empty">{t("palette.empty")}</p>
          ) : (
            visible.map((item, index) => {
              const header = item.group !== lastGroup ? groupTitles[item.group] : null
              lastGroup = item.group
              return (
                <div key={item.id}>
                  {header ? <div className="palette-group">{header}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? "palette-item is-active" : "palette-item"}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      item.run()
                      props.onClose()
                    }}
                  >
                    <span className="palette-icon">
                      <Icon name={item.icon} />
                    </span>
                    <span className="palette-label truncate">{item.label}</span>
                    {item.hint ? <span className="palette-hint truncate">{item.hint}</span> : null}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="palette-foot">{t("palette.hint")}</div>
      </div>
    </div>
  )
}

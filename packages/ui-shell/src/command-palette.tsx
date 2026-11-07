/** 命令面板：命令来自 Command 扩展点，后面接会话切换与项目。 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { contributionText, useContributions } from "@pigcode/client-runtime"
import { EmptyState, ListRow, SearchField, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import { Icon, hasIcon } from "./icon"

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

/** 命令面板属性；会话与项目数据由调用方传入，命令来自扩展点注册表。 */
export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  threads: Thread[]
  projects: Project[]
  activeThreadId: string | null
  /** 进入新会话草稿；从「项目」组选的项目作为草稿的项目。 */
  onNewThread: (projectId?: string) => void
  onOpenThread: (threadId: string) => void
}

/** 渲染居中的命令面板；↑↓ 移动，回车执行，Esc 关闭。 */
export function CommandPalette(props: CommandPaletteProps) {
  const { t } = useLocale()
  const commands = useContributions("command")
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // available() 在每次打开面板时重新判断：它可能依赖注册表以外的状态（例如开发服务器有没有启动）。
  const actions = useMemo<PaletteItem[]>(
    () =>
      (props.open ? commands : [])
        .filter((command) => command.available?.() ?? true)
        .map((command) => ({
          id: `command-${command.id}`,
          group: "actions" as const,
          label: contributionText(t, command.title),
          // 插件给的图标名不在图标表里时用通用图标，不留空白。
          icon: command.icon && hasIcon(command.icon) ? command.icon : "spark",
          keywords: (command.keywords ?? []).join(" "),
          ...(command.shortcut ? { hint: formatShortcut(command.shortcut) } : {}),
          // 命令返回值不用等：面板关掉后它继续跑。
          run: () => void command.run(),
        })),
    [commands, props.open, t],
  )

  const items = useMemo<PaletteItem[]>(() => {
    // 与侧栏一致：已归档的会话和已从侧栏移除的项目里的会话都不列出。
    const known = new Set(props.projects.map((project) => project.id))
    const threads = props.threads
      .filter((thread) => thread.archivedAt === null && known.has(thread.projectId))
      .map((thread) => ({
        id: `thread-${thread.id}`,
        group: "threads" as const,
        label: thread.title,
        hint: thread.defaultAgentId,
        icon: "chat",
        keywords: `${thread.title} ${thread.defaultAgentId}`,
        run: () => props.onOpenThread(thread.id),
      }))
    const projects = props.projects.map((project) => ({
      id: `project-${project.id}`,
      group: "projects" as const,
      label: project.name,
      hint: project.rootPath,
      icon: "folder",
      keywords: `${project.name} ${project.rootPath}`,
      run: () => props.onNewThread(project.id),
    }))
    return [...actions, ...threads, ...projects]
  }, [actions, props, t])

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
      className="scrim palette-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="popup palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.actions")}
      >
        <div className="palette-search">
          <SearchField
            variant="plain"
            inputRef={inputRef}
            value={query}
            onValueChange={(value) => {
              setQuery(value)
              setActive(0)
            }}
            placeholder={t("palette.placeholder")}
            trailing={<kbd>esc</kbd>}
          />
        </div>
        <div className="palette-list" role="listbox" aria-label={t("palette.actions")}>
          {visible.length === 0 ? (
            <EmptyState size="compact" title={t("palette.empty")} />
          ) : (
            visible.map((item, index) => {
              const header = item.group !== lastGroup ? groupTitles[item.group] : null
              lastGroup = item.group
              return (
                <div key={item.id}>
                  {header ? <div className="palette-group">{header}</div> : null}
                  <ListRow
                    render={<button type="button" />}
                    role="option"
                    aria-selected={index === active}
                    data-highlighted={index === active ? "" : undefined}
                    className="palette-item"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      item.run()
                      props.onClose()
                    }}
                    leading={
                      <span className="palette-icon">
                        <Icon name={item.icon} />
                      </span>
                    }
                    title={item.label}
                    meta={
                      item.hint ? <span className="palette-hint truncate">{item.hint}</span> : null
                    }
                  />
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

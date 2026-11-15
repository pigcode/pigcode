/** Composer 的项目选择条，普通草稿与定时任务共用。 */
import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react"
import { Menu, useLocale } from "@pigcode/ui-primitives"

export interface ComposerProject {
  id: string
  name: string
  rootPath: string
}

/** 已有会话或任务的固定项目。 */
export function ProjectChip({ name, rootPath }: { name: string; rootPath?: string | undefined }) {
  const { t } = useLocale()
  return (
    <span className="chip-btn draft-project" data-static="" title={rootPath}>
      <Folder className="ic" aria-hidden="true" />
      <span className="sr-only">{`${t("newThread.project")}: `}</span>
      <span className="truncate">{name}</span>
    </span>
  )
}

/** 项目选择；还没有项目时直接是「添加项目」。 */
export function ProjectMenu({
  projects,
  projectId,
  onSelect,
  onAdd,
  disabled,
  side = "bottom",
}: {
  projects: readonly ComposerProject[]
  projectId: string | null
  onSelect: (projectId: string) => void
  onAdd?: (() => void) | undefined
  disabled: boolean
  side?: "top" | "bottom"
}) {
  const { t } = useLocale()
  const current = projects.find((project) => project.id === projectId)
  if (projects.length === 0) {
    return (
      <button
        type="button"
        className="chip-btn draft-project"
        onClick={onAdd}
        disabled={disabled || !onAdd}
      >
        <FolderPlus className="ic" aria-hidden="true" />
        <span>{t("nav.addProject")}</span>
      </button>
    )
  }
  const label = current?.name ?? t("newThread.pickProject")
  return (
    <Menu.Root>
      <Menu.Trigger
        className="chip-btn draft-project"
        type="button"
        disabled={disabled}
        aria-label={`${t("newThread.project")}: ${label}`}
        title={current?.rootPath}
      >
        <Folder className="ic" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} align="start" sideOffset={6}>
          <Menu.Popup className="draft-project-menu">
            <Menu.Group>
              <Menu.Label>{t("nav.projects")}</Menu.Label>
              {projects.map((project) => (
                <Menu.Item
                  key={project.id}
                  data-project={project.id}
                  onClick={() => onSelect(project.id)}
                >
                  <Folder className="ic" aria-hidden="true" />
                  <span className="grow">
                    <span className="truncate">{project.name}</span>
                    <span className="menu-item-desc truncate">{project.rootPath}</span>
                  </span>
                  {project.id === projectId ? (
                    <Check className="ic check-mark" aria-hidden="true" />
                  ) : null}
                </Menu.Item>
              ))}
            </Menu.Group>
            {onAdd ? (
              <>
                <Menu.Separator />
                <Menu.Item onClick={onAdd}>
                  <FolderPlus className="ic" aria-hidden="true" />
                  <span className="grow">{t("newThread.addProject")}</span>
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

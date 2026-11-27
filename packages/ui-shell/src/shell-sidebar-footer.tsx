/** 应用外壳底部主机状态胶囊、快捷加主机与设置入口组件，以及侧栏/弹窗蒙层。 */
import type { HostBrowseDirsResult, HostSummary, Project, Thread } from "@pigcode/contracts"
import { Button, HostDot, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"
import { CommandPalette } from "./command-palette"
import { Icon } from "./icon"

export function ShellSidebarFooter({
  hosts,
  activeHostId,
  onOpenHostsSettings,
  onOpenAddHost,
  onOpenSettings,
}: {
  hosts?: readonly HostSummary[] | undefined
  activeHostId?: string | undefined
  onOpenHostsSettings: () => void
  onOpenAddHost?: (() => void) | undefined
  onOpenSettings: () => void
}) {
  const { t } = useLocale()
  const active = hosts ? (hosts.find((h) => h.id === activeHostId) ?? hosts[0]) : undefined
  return (
    <div className="side-foot">
      {hosts && hosts.length > 0 ? (
        <button
          type="button"
          className="side-foot-cluster"
          onClick={onOpenHostsSettings}
          title={t("settings.remoteHosts")}
        >
          <HostDot
            color={active?.badgeColor ?? "blue"}
            offline={hosts.every((h) => h.status !== "connected")}
          />
          <span className="truncate">
            {`${t("hosts.clusterLabel")} · ${hosts.filter((h) => h.status === "connected").length}/${hosts.length}`}
          </span>
        </button>
      ) : (
        <span className="side-account">
          <span className="side-avatar" aria-hidden="true">
            <Icon name="snout" />
          </span>
          <span className="truncate">Pigcode</span>
        </span>
      )}
      {onOpenAddHost ? (
        <Button
          variant="plain"
          className="icon-btn foot-gear"
          type="button"
          aria-label={t("hosts.addHost")}
          title={t("hosts.addHost")}
          onClick={onOpenAddHost}
        >
          <Icon name="plus" small />
        </Button>
      ) : null}
      <Button
        variant="plain"
        className="icon-btn foot-gear"
        type="button"
        aria-label={t("settings.title")}
        title={`${t("settings.title")} ${formatShortcut("Mod+,")}`}
        onClick={onOpenSettings}
      >
        <Icon name="gear" />
      </Button>
    </div>
  )
}

export function ShellOverlays({
  dialogOpen,
  onDialogOpenChange,
  paletteOpen,
  onPaletteClose,
  hosts,
  targetHostId,
  browseRemoteDirs,
  projects,
  threads,
  activeThreadId,
  onAddProject,
  onNewThread,
  onOpenThread,
}: {
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  paletteOpen: boolean
  onPaletteClose: () => void
  hosts?: readonly HostSummary[] | undefined
  targetHostId?: string | undefined
  browseRemoteDirs?: ((hostId: string, path?: string) => Promise<HostBrowseDirsResult>) | undefined
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  onAddProject: (path: string, name?: string, hostId?: string) => void
  onNewThread: (projectId?: string) => void
  onOpenThread: (threadId: string) => void
}) {
  return (
    <>
      <AddProjectDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        hosts={hosts}
        targetHostId={targetHostId}
        browseRemoteDirs={browseRemoteDirs}
        onAdd={(path, name, hostId) => onAddProject(path, name, hostId)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={onPaletteClose}
        projects={projects}
        threads={threads}
        activeThreadId={activeThreadId}
        onNewThread={(projectId) => onNewThread(projectId)}
        onOpenThread={onOpenThread}
      />
    </>
  )
}

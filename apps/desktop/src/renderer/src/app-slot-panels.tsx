/** 懒加载的右侧工作台面板与底部终端抽屉插槽，按当前激活主机隔离状态。 */
import { Suspense, lazy, type ReactNode } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { HostSummary } from "@pigcode/contracts"
import { EMPTY_SURFACE_STATE, type PanelSurfaceState } from "@pigcode/ui-workbench"
import type { useAppPanels } from "./use-app-panels"

type SlotScope = ReturnType<typeof useAppPanels>["slot"]["scope"]
type RecoveryState = ReturnType<typeof useAppPanels>["terminalRecovery"]

const WorkbenchPanel = lazy(() =>
  import("./workbench").then((module) => ({ default: module.WorkbenchPanel })),
)
const TerminalDrawer = lazy(() =>
  import("./terminal-drawer").then((module) => ({ default: module.TerminalDrawer })),
)

export function AppWorkbenchSlot({
  activeHostId,
  activeConnection,
  activeHost,
  showHostBadge,
  slotScope,
  slotKey,
  panel,
  rightStarted,
  rightOpen,
  controls,
  projectName,
  workspaceRevision,
  checkoutRevision,
  onPanelChange,
  onError,
  onCheckoutChanged,
}: {
  activeHostId: string
  activeConnection: Connection
  activeHost: HostSummary | undefined
  showHostBadge: boolean
  slotScope: SlotScope
  slotKey: string | null
  panel: PanelSurfaceState | undefined
  rightStarted: boolean
  rightOpen: boolean
  controls: ReactNode
  projectName: string
  workspaceRevision: number
  checkoutRevision: number
  onPanelChange: (
    slotKey: string,
    update: Parameters<typeof import("./workbench").WorkbenchPanel>[0]["onPanelChange"] extends (
      u: infer U,
    ) => void
      ? U
      : never,
  ) => void
  onError: (message: string) => void
  onCheckoutChanged: () => void
}) {
  if (!slotScope || !slotKey || !(rightStarted || rightOpen)) return undefined
  return (
    <Suspense fallback={null}>
      <WorkbenchPanel
        key={`${activeHostId}:${slotKey}`}
        connection={activeConnection}
        host={activeHost}
        showHostBadge={showHostBadge}
        scope={slotScope}
        slotKey={`${activeHostId}:${slotKey}`}
        panel={panel ?? EMPTY_SURFACE_STATE}
        onPanelChange={(update) => onPanelChange(slotKey, update)}
        controls={controls}
        onError={onError}
        projectName={projectName}
        workspaceRevision={workspaceRevision}
        checkoutRevision={checkoutRevision}
        onCheckoutChanged={onCheckoutChanged}
      />
    </Suspense>
  )
}

export function AppTerminalSlot({
  activeHostId,
  activeConnection,
  slotScope,
  slotKey,
  terminalStarted,
  terminalOpen,
  inChat,
  terminalRecovery,
  onClose,
}: {
  activeHostId: string
  activeConnection: Connection
  slotScope: SlotScope
  slotKey: string | null
  terminalStarted: boolean
  terminalOpen: boolean
  inChat: boolean
  terminalRecovery: RecoveryState
  onClose: () => void
}) {
  if (!slotScope || !slotKey || !terminalStarted) return undefined
  return (
    <Suspense fallback={null}>
      <TerminalDrawer
        key={`${activeHostId}:${slotKey}`}
        connection={activeConnection}
        owner={slotScope}
        open={terminalOpen && inChat}
        onClose={onClose}
        initialSessions={terminalRecovery.drawerSessionsBySlot[slotKey]}
        recovering={terminalRecovery.recovering}
        onTerminalBound={(id) => terminalRecovery.registerDrawerTerminal(slotKey, id)}
        onTerminalClosed={(id) => terminalRecovery.unregisterDrawerTerminal(slotKey, id)}
      />
    </Suspense>
  )
}

/** 窗口级更新状态，设置页和顶栏读取同一份 CLI 与应用更新信息。 */
import { createContext, useContext, useEffect, useState } from "react"
import type { DesktopUpdateState } from "@pigcode/contracts"
import type { AppStore, Connection, ConnectionStatus } from "@pigcode/client-runtime"
import { UpdateCenter } from "@pigcode/ui-shell"
import { refreshAgentViews } from "./agent-context"
import { useCliUpdates } from "./use-cli-updates"

export function useUpdateCenterState(
  connection: Connection,
  store: AppStore,
  status: ConnectionStatus,
  agentNames: Readonly<Record<string, string>>,
) {
  const [appUpdate, setAppUpdate] = useState<DesktopUpdateState | null>(null)
  const [open, setOpen] = useState(false)
  const [focusInstance, setFocusInstance] = useState<string | null>(null)
  const cli = useCliUpdates(
    connection,
    status === "connected",
    () => refreshAgentViews({ connection, store }),
    {
      autoCheck: appUpdate?.autoCheck ?? false,
      instanceIds: Object.keys(agentNames),
    },
  )
  useEffect(() => {
    const native = window.pigcodeNative
    let changed = false
    let cancelled = false
    const off = native?.onUpdateState?.((state) => {
      changed = true
      setAppUpdate(state)
    })
    void native
      ?.getUpdateState?.()
      .then((state) => {
        if (!changed && !cancelled) setAppUpdate(state)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  const controller = {
    cli,
    appUpdate,
    open,
    focusInstance,
    setOpen: (next: boolean) => {
      setOpen(next)
      if (!next) setFocusInstance(null)
    },
    show: (instanceId?: string) => {
      setFocusInstance(instanceId ?? null)
      setOpen(true)
    },
    async check() {
      await Promise.all([cli.check(), window.pigcodeNative?.checkForUpdates?.()])
    },
    async updateApp() {
      const state = await window.pigcodeNative?.performUpdate?.()
      if (state) setAppUpdate(state)
    },
  }
  return {
    ...controller,
    indicator: (
      <UpdateCenter
        app={appUpdate}
        cli={cli.states}
        agentNames={agentNames}
        open={open}
        onOpenChange={controller.setOpen}
        focusInstance={focusInstance}
        checking={cli.checking || appUpdate?.phase === "checking"}
        onCheck={controller.check}
        onUpdateApp={controller.updateApp}
        onUpdateCli={cli.update}
      />
    ),
  }
}

export type UpdateCenterState = ReturnType<typeof useUpdateCenterState>
export const UpdateCenterContext = createContext<UpdateCenterState | null>(null)

export function useUpdateCenter(): UpdateCenterState {
  const value = useContext(UpdateCenterContext)
  if (!value) throw new Error("Update center is unavailable")
  return value
}

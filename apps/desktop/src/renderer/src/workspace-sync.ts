/** 连上或重连 Host 时同步项目和会话列表，补齐 Host 重启恢复的中断状态与离线期间新增会话（#84）。 */
import { useEffect } from "react"
import { useAppStore, type AppStore, type Connection } from "@pigcode/client-runtime"
import { loadWorkspace } from "./workspace-actions"

export function useWorkspaceSync(
  connection: Connection,
  store: AppStore,
  onError: (error: unknown) => void,
): void {
  const { status, connectionRevision } = useAppStore(store)
  useEffect(() => {
    if (status !== "connected") return
    void loadWorkspace(connection, store).catch(onError)
  }, [status, connectionRevision, connection, store, onError])
}

import { useSyncExternalStore } from "react"
import type { HostPool, HostPoolSnapshot } from "./host-pool"

/** 在 React 组件中订阅多主机连接池快照。 */
export function useHostPool(pool: HostPool): HostPoolSnapshot {
  return useSyncExternalStore(pool.subscribe, pool.getSnapshot, pool.getSnapshot)
}

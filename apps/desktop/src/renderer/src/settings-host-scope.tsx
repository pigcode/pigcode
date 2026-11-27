/**
 * 设置页多主机作用域上下文：
 * 让「当前配置主机 ▾」下拉切换的目标主机能实时驱动 Agent 实例、插件与守护进程/中继页面，
 * 同时向后兼容单机测试（未挂载作用域上下文时自动回落到本地依赖）。
 */
import { createContext, useContext, useMemo } from "react"
import { HOST_LOCAL_ID, type HostSummary } from "@pigcode/contracts"
import { HostPool, useHostPool } from "@pigcode/client-runtime"
import type { CoreDeps } from "./chat-container"

export interface SettingsHostScopeValue {
  hostPool: HostPool
  targetHostId: string
  setTargetHostId: (hostId: string) => void
  onOpenSettingsPage: (page: string) => void
  onStartDraftOnHost: (hostId: string, prefill: (draftKey: string) => void) => boolean
  onOpenAddHost?: (() => void) | undefined
}

export const SettingsHostScopeContext = createContext<SettingsHostScopeValue | null>(null)

export function useSettingsHostScope(deps: CoreDeps): {
  hostPool: HostPool
  hosts: readonly HostSummary[]
  targetHostId: string
  targetHost: HostSummary
  targetDeps: CoreDeps
  setTargetHostId: (hostId: string) => void
  onOpenSettingsPage: (page: string) => void
  onStartDraftOnHost: (hostId: string, prefill: (draftKey: string) => void) => boolean
  onOpenAddHost?: (() => void) | undefined
} {
  const ctx = useContext(SettingsHostScopeContext)
  const fallbackPool = useMemo(
    () => new HostPool({ localConnection: deps.connection, localStore: deps.store }),
    [deps.connection, deps.store],
  )
  const pool = ctx?.hostPool ?? fallbackPool
  const snap = useHostPool(pool)
  const resolvedId = ctx && pool.hasSlot(ctx.targetHostId) ? ctx.targetHostId : HOST_LOCAL_ID
  const slot = pool.slot(resolvedId)
  const targetHost = snap.hosts.find((h) => h.id === slot.id) ?? snap.hosts[0]!
  return {
    hostPool: pool,
    hosts: snap.hosts,
    targetHostId: slot.id,
    targetHost,
    targetDeps: {
      connection: slot.connection,
      store: slot.store,
      plugins: deps.plugins,
    },
    setTargetHostId: ctx?.setTargetHostId ?? (() => undefined),
    onOpenSettingsPage: ctx?.onOpenSettingsPage ?? (() => undefined),
    onStartDraftOnHost: ctx?.onStartDraftOnHost ?? (() => false),
    onOpenAddHost: ctx?.onOpenAddHost,
  }
}

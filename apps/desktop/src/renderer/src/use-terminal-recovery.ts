/**
 * 页面重载或连接恢复后，按当前会话/新会话草稿查询 Host 仍在运行的终端，
 * 并自动还原到底部抽屉或右侧 Workbench（#85）。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { Connection } from "@pigcode/client-runtime"
import { translate, type Locale } from "@pigcode/ui-primitives"
import {
  EMPTY_SURFACE_STATE,
  addSurface,
  updateSurface,
  type PanelSurfaceState,
} from "@pigcode/ui-workbench"
import type { TerminalSession } from "./terminal-surface"
import type { WorkspaceScope } from "./workspace-scope"

export interface UseTerminalRecoveryOptions {
  connection: Connection
  connected: boolean
  connectionRevision: number
  slotKey: string | null
  scope: WorkspaceScope | null
  panels: Record<string, PanelSurfaceState>
  setPanels: Dispatch<SetStateAction<Record<string, PanelSurfaceState>>>
  onOpenDrawer: (slotKey: string, isDraft: boolean) => void
  onOpenWorkbench: (slotKey: string, isDraft: boolean) => void
  locale: Locale
}

export interface TerminalRecoveryState {
  /** 按 slotKey 保存的已恢复底部抽屉终端列表。 */
  drawerSessionsBySlot: Record<string, TerminalSession[]>
  /** 当前槽位的 terminal.list 恢复查询是否尚未落定；为 true 时抽屉暂不自动新开空白终端。 */
  recovering: boolean
  /** 当抽屉里某个终端成功打开或附着后登记其 id，避免重连查询重复恢复。 */
  registerDrawerTerminal: (slotKey: string, terminalId: string) => void
  /** 当抽屉里某个终端被关闭或退出时从恢复列表移除。 */
  unregisterDrawerTerminal: (slotKey: string, terminalId: string) => void
}

function scopeKeyOf(scope: WorkspaceScope | null): string | null {
  if (!scope) return null
  return "threadId" in scope ? `thread:${scope.threadId}` : `project:${scope.projectId}`
}

export function useTerminalRecovery({
  connection,
  connected,
  connectionRevision,
  slotKey,
  scope,
  panels,
  setPanels,
  onOpenDrawer,
  onOpenWorkbench,
  locale,
}: UseTerminalRecoveryOptions): TerminalRecoveryState {
  const [drawerSessionsBySlot, setDrawerSessionsBySlot] = useState<
    Record<string, TerminalSession[]>
  >({})
  const boundDrawerIdsRef = useRef<Map<string, Set<string>>>(new Map())
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const callbacksRef = useRef({ onOpenDrawer, onOpenWorkbench, locale })
  callbacksRef.current = { onOpenDrawer, onOpenWorkbench, locale }
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const scopeKey = scopeKeyOf(scope)
  const currentTarget =
    connected && slotKey && scopeKey ? `${connectionRevision}:${slotKey}:${scopeKey}` : null
  const [settledTarget, setSettledTarget] = useState<string | null>(null)
  const recovering = currentTarget !== null && settledTarget !== currentTarget

  // 离开旧 slotKey 时旧抽屉会随 key 卸载并关闭终端，同步清理它的恢复缓存。
  const previousSlotRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = previousSlotRef.current
    previousSlotRef.current = slotKey
    if (prev && prev !== slotKey) {
      boundDrawerIdsRef.current.delete(prev)
      setDrawerSessionsBySlot((current) => {
        if (!(prev in current)) return current
        const rest = { ...current }
        delete rest[prev]
        return rest
      })
    }
  }, [slotKey])

  const registerDrawerTerminal = useCallback((key: string, terminalId: string) => {
    let ids = boundDrawerIdsRef.current.get(key)
    if (!ids) {
      ids = new Set()
      boundDrawerIdsRef.current.set(key, ids)
    }
    ids.add(terminalId)
  }, [])

  const unregisterDrawerTerminal = useCallback((key: string, terminalId: string) => {
    boundDrawerIdsRef.current.get(key)?.delete(terminalId)
    setDrawerSessionsBySlot((current) => {
      const existing = current[key]
      if (!existing || !existing.some((item) => item.id === terminalId)) return current
      const next = existing.filter((item) => item.id !== terminalId)
      if (next.length === 0) {
        const rest = { ...current }
        delete rest[key]
        return rest
      }
      return { ...current, [key]: next }
    })
  }, [])

  useEffect(() => {
    if (!currentTarget || !slotKey || !scopeKey || !scopeRef.current) return undefined
    let cancelled = false
    const activeScope = scopeRef.current
    const isDraft = !("threadId" in activeScope)
    const targetSlotKey = slotKey
    const target = currentTarget

    void connection
      .call("terminal.list", activeScope)
      .then((raw) => {
        if (cancelled) return
        if (!Array.isArray(raw)) {
          setSettledTarget(target)
          return
        }
        const sessions = raw as TerminalSession[]
        if (sessions.length === 0) {
          setSettledTarget(target)
          return
        }

        const drawerIncoming: TerminalSession[] = []
        const workbenchIncoming: TerminalSession[] = []
        for (const session of sessions) {
          if (session.placement === "workbench") workbenchIncoming.push(session)
          else drawerIncoming.push(session)
        }

        if (drawerIncoming.length > 0) {
          let known = boundDrawerIdsRef.current.get(targetSlotKey)
          if (!known) {
            known = new Set()
            boundDrawerIdsRef.current.set(targetSlotKey, known)
          }
          const toRecover = drawerIncoming.filter((session) => !known.has(session.id))
          if (toRecover.length > 0) {
            for (const session of toRecover) known.add(session.id)
            setDrawerSessionsBySlot((current) => {
              const existing = current[targetSlotKey] ?? []
              const existingIds = new Set(existing.map((item) => item.id))
              const merged = [...existing, ...toRecover.filter((item) => !existingIds.has(item.id))]
              return { ...current, [targetSlotKey]: merged }
            })
            callbacksRef.current.onOpenDrawer(targetSlotKey, isDraft)
          }
        }

        if (workbenchIncoming.length > 0) {
          const currentPanel = panelsRef.current[targetSlotKey] ?? EMPTY_SURFACE_STATE
          const hasMissing = workbenchIncoming.some(
            (session) =>
              !currentPanel.surfaces.some(
                (surface) => surface.kind === "terminal" && surface.terminalId === session.id,
              ),
          )
          if (hasMissing) {
            const label = translate(callbacksRef.current.locale, "workbench.terminal")
            setPanels((all) => {
              let panel = all[targetSlotKey] ?? EMPTY_SURFACE_STATE
              let changed = false
              for (const session of workbenchIncoming) {
                if (
                  panel.surfaces.some(
                    (surface) => surface.kind === "terminal" && surface.terminalId === session.id,
                  )
                ) {
                  continue
                }
                const id = `terminal-${session.id}`
                panel = addSurface(panel, "terminal", id, (index) => `${label} ${index}`, {
                  multiInstance: true,
                })
                panel = updateSurface(panel, id, { terminalId: session.id })
                changed = true
              }
              return changed ? { ...all, [targetSlotKey]: panel } : all
            })
            callbacksRef.current.onOpenWorkbench(targetSlotKey, isDraft)
          }
        }

        setSettledTarget(target)
      })
      .catch(() => {
        // 旧版 Host 不支持 terminal.list 时静默降级，不打断界面。
        if (!cancelled) setSettledTarget(target)
      })

    return () => {
      cancelled = true
    }
  }, [currentTarget, slotKey, scopeKey, connection, setPanels])

  return { drawerSessionsBySlot, recovering, registerDrawerTerminal, unregisterDrawerTerminal }
}

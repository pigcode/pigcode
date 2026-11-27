/** 计算多主机混排项目/会话归属与合并运行态的 Hook。 */
import { useMemo } from "react"
import type { HostPool, HostPoolSnapshot, HostSlot } from "@pigcode/client-runtime"
import type { HostSummary } from "@pigcode/contracts"
import { mergeChildStatus } from "./thread-status"
import {
  addProject,
  archiveThread,
  markAllThreadsRead,
  removeProject,
  renameProject,
  renameThread,
  setThreadPinned,
  setThreadRead,
  unarchiveThread,
} from "./workspace-actions"

export function buildHostWorkspaceHandlers({
  pool,
  hosts,
  activeSlot,
  hostOfProject,
  hostOfThread,
  onSelectHost,
  onSlotError,
  routeNextThread,
}: {
  pool: HostPool
  hosts: readonly HostSummary[]
  activeSlot: HostSlot
  hostOfProject: Readonly<Record<string, HostSummary>>
  hostOfThread: Readonly<Record<string, HostSummary>>
  onSelectHost: (hostId: string) => void
  onSlotError: (targetStore: HostSlot["store"]) => (error: unknown) => void
  routeNextThread: (ownerId: string, nextThreadId: string | null) => void
}) {
  return {
    onAddProject: (path: string, name?: string, targetHostId?: string) => {
      const target = pool.slot(targetHostId ?? activeSlot.id)
      onSelectHost(target.id)
      void addProject(target.connection, target.store, path, name).catch(onSlotError(target.store))
    },
    onRenameThread: (threadId: string, title: string) => {
      const target = pool.slot(hostOfThread[threadId]?.id ?? activeSlot.id)
      void renameThread(target.connection, target.store, threadId, title).catch(
        onSlotError(target.store),
      )
    },
    onArchiveThread: (threadId: string) => {
      const target = pool.slot(hostOfThread[threadId]?.id ?? activeSlot.id)
      void archiveThread(target.connection, target.store, threadId).then(
        (nextId) => routeNextThread(target.id, nextId),
        onSlotError(target.store),
      )
    },
    onSetThreadPinned: (threadId: string, pinned: boolean) => {
      const target = pool.slot(hostOfThread[threadId]?.id ?? activeSlot.id)
      void setThreadPinned(target.connection, target.store, threadId, pinned).catch(
        onSlotError(target.store),
      )
    },
    onUnarchiveThread: (threadId: string) => {
      const target = pool.slot(hostOfThread[threadId]?.id ?? activeSlot.id)
      void unarchiveThread(target.connection, target.store, threadId).catch(
        onSlotError(target.store),
      )
    },
    onMarkThreadRead: (threadId: string, read: boolean) => {
      const target = pool.slot(hostOfThread[threadId]?.id ?? activeSlot.id)
      void setThreadRead(target.connection, target.store, threadId, read).catch(
        onSlotError(target.store),
      )
    },
    onMarkAllRead: () => {
      for (const host of hosts) {
        if (host.status !== "connected") continue
        const target = pool.slot(host.id)
        void markAllThreadsRead(target.connection, target.store).catch(onSlotError(target.store))
      }
    },
    onRenameProject: (projectId: string, name: string) => {
      const target = pool.slot(hostOfProject[projectId]?.id ?? activeSlot.id)
      void renameProject(target.connection, target.store, projectId, name).catch(
        onSlotError(target.store),
      )
    },
    onRemoveProject: (projectId: string) => {
      const target = pool.slot(hostOfProject[projectId]?.id ?? activeSlot.id)
      void removeProject(target.connection, target.store, projectId).then(
        (nextId) => routeNextThread(target.id, nextId),
        onSlotError(target.store),
      )
    },
  }
}

export function useMultiHostWorkspace(pool: HostPool, poolSnap: HostPoolSnapshot) {
  const mixedProjectsEntries = useMemo(() => pool.mixedProjects(), [pool, poolSnap.revision])
  const mixedThreadsEntries = useMemo(() => pool.mixedThreads(), [pool, poolSnap.revision])
  const sidebarProjects = useMemo(
    () => mixedProjectsEntries.map((entry) => entry.project),
    [mixedProjectsEntries],
  )
  const sidebarThreads = useMemo(
    () => mixedThreadsEntries.map((entry) => entry.thread),
    [mixedThreadsEntries],
  )
  const hostOfProject = useMemo(() => {
    const out: Record<string, HostSummary> = {}
    for (const entry of mixedProjectsEntries) out[entry.project.id] = entry.host
    return out
  }, [mixedProjectsEntries])
  const hostOfThread = useMemo(() => {
    const out: Record<string, HostSummary> = {}
    for (const entry of mixedThreadsEntries) out[entry.thread.id] = entry.host
    return out
  }, [mixedThreadsEntries])

  // 合并所有主机的会话运行态，让混排侧栏显示准确的状态点与动画。
  const threadStatus = useMemo(() => {
    const merged: Record<string, ReturnType<typeof mergeChildStatus>[string]> = {}
    for (const host of poolSnap.hosts) {
      const snap = pool.slot(host.id).store.getSnapshot()
      Object.assign(merged, mergeChildStatus(snap.threads, snap.threadStates))
    }
    return merged
  }, [pool, poolSnap.hosts, poolSnap.revision])

  return {
    sidebarProjects,
    sidebarThreads,
    hostOfProject,
    hostOfThread,
    threadStatus,
  }
}

/** 应用级工作台右栏、底部终端与浏览器标签状态管理。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { Thread } from "@pigcode/contracts"
import { translate, type Locale } from "@pigcode/ui-primitives"
import type { ShellView } from "@pigcode/ui-shell"
import {
  EMPTY_SURFACE_STATE,
  addSurface,
  closeRemovedSurfaces,
  openFileSurface,
  type PanelSurfaceState,
} from "@pigcode/ui-workbench"
import { useBrowserOpen } from "./use-browser-open"
import { usePanelOpen } from "./use-panel-open"
import { useTerminalRecovery } from "./use-terminal-recovery"
import { useWorkspaceSlot } from "./use-workspace-slot"

export interface UseAppPanelsOptions {
  connection: Connection
  connected: boolean
  connectionRevision: number
  view: ShellView
  activeThreadId: string | null
  draftProject: string | null
  threads: readonly Thread[]
  surfaceIds: readonly string[]
  locale: Locale
  onStartDraft: (projectId?: string) => void
}

/** 统一管理右栏工作台、底部终端、浏览器实例列表与终端恢复。 */
export function useAppPanels({
  connection,
  connected,
  connectionRevision,
  view,
  activeThreadId,
  draftProject,
  threads,
  surfaceIds,
  locale,
  onStartDraft,
}: UseAppPanelsOptions) {
  // 右栏第一次打开后才挂载（按需加载工作台代码），之后收起只隐藏，终端与浏览器标签保留。
  const [rightStarted, setRightStarted] = useState(false)
  const [rightMaximized, setRightMaximized] = useState(false)
  // 底部终端第一次打开后才挂载，之后收起只隐藏，shell 会话保留到切换线程。
  const [terminalStarted, setTerminalStarted] = useState(false)
  const inChat = view === "chat"
  const slot = useWorkspaceSlot(activeThreadId, draftProject)
  const { rightOpen, setRightOpen, terminalOpen, setTerminalOpen } = usePanelOpen(
    draftProject ? slot.key : null,
  )
  const [panels, setPanels] = useState<Record<string, PanelSurfaceState>>({})
  const registeredSurfaces = useRef<ReadonlySet<string>>(new Set())

  // Surface 注销（插件停用或卸载）时关掉每个线程里它已经打开的标签，当前标签改选邻居。
  useEffect(() => {
    const current = new Set(surfaceIds)
    const removed = new Set([...registeredSurfaces.current].filter((id) => !current.has(id)))
    registeredSurfaces.current = current
    if (removed.size === 0) return
    setPanels((currentPanels) => {
      let changed = false
      const next: Record<string, PanelSurfaceState> = {}
      for (const [threadId, panel] of Object.entries(currentPanels)) {
        next[threadId] = closeRemovedSurfaces(panel, removed)
        if (next[threadId] !== panel) changed = true
      }
      return changed ? next : currentPanels
    })
  }, [surfaceIds])

  useEffect(() => {
    if (rightOpen) setRightStarted(true)
  }, [rightOpen])

  function toggleRight(): void {
    if (!inChat || !slot.scope) return
    setRightOpen((value) => !value)
    setRightMaximized(false)
  }

  function toggleTerminal(): void {
    if (!inChat || !slot.scope) return
    setRightMaximized(false)
    setTerminalStarted(true)
    setTerminalOpen((value) => rightMaximized || !value)
  }

  /** 改一个面板的标签；key 是 slot key（会话 id，或者草稿的 key）。 */
  const updatePanel = useCallback(
    (key: string, update: (panel: PanelSurfaceState) => PanelSurfaceState) => {
      setPanels((current) => ({
        ...current,
        [key]: update(current[key] ?? EMPTY_SURFACE_STATE),
      }))
    },
    [],
  )

  const showRightPanel = useCallback(() => {
    setRightOpen(true)
    setRightMaximized(false)
  }, [setRightOpen])

  const openRecoveredDrawer = useCallback(
    (key: string, isDraft: boolean) => {
      setTerminalStarted(true)
      setTerminalOpen(true, isDraft ? key : null)
    },
    [setTerminalOpen],
  )

  const openRecoveredWorkbench = useCallback(
    (key: string, isDraft: boolean) => {
      setRightStarted(true)
      setRightOpen(true, isDraft ? key : null)
      setRightMaximized(false)
    },
    [setRightOpen],
  )

  const terminalRecovery = useTerminalRecovery({
    connection,
    connected,
    connectionRevision,
    slotKey: slot.key,
    scope: slot.scope,
    panels,
    setPanels,
    onOpenDrawer: openRecoveredDrawer,
    onOpenWorkbench: openRecoveredWorkbench,
    locale,
  })

  function browseProjectFiles(projectId: string): void {
    const key = slot.draftKeyOf(projectId)
    onStartDraft(projectId)
    updatePanel(key, (panel) =>
      addSurface(panel, "files", `files-${crypto.randomUUID()}`, () =>
        translate(locale, "workbench.files"),
      ),
    )
    setRightOpen(true, key)
    setRightMaximized(false)
  }

  // agent 调用浏览器工具时，main 让界面给它的线程开（或亮出）浏览器标签；正在看这个线程时展开右栏。
  useBrowserOpen({
    panels,
    keyOf: slot.keyOf,
    threadId: activeThreadId,
    view,
    setPanels,
    onOpenRight: showRightPanel,
    locale,
  })

  /** 从聊天里打开文件或 Diff：当前线程的右栏切到对应标签（文件在自己的标签里打开）并展开。 */
  function openSurface(kind: "file" | "diff", path?: string): void {
    if (!activeThreadId) return
    updatePanel(slot.keyOf(activeThreadId), (panel) =>
      kind === "file" && path
        ? openFileSurface(panel, path, `file-${crypto.randomUUID()}`)
        : addSurface(panel, "diff", `diff-${crypto.randomUUID()}`, () => "Diff"),
    )
    showRightPanel()
  }

  const openLinkTab = useCallback(
    (url: string) => {
      if (!slot.key) return
      const id = `browser-${crypto.randomUUID()}`
      const title = new URL(url).host
      updatePanel(slot.key, (panel) => ({
        surfaces: [...panel.surfaces, { id, kind: "browser", title, url }],
        activeId: id,
      }))
      showRightPanel()
    },
    [slot.key, showRightPanel, updatePanel],
  )

  // 草稿里开的浏览器也挂着；它还不属于哪个会话，agent 用不了，建好会话后才交给那个会话的 agent。
  const { threadOf } = slot
  const browsers = useMemo(() => {
    const live = new Set(
      threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
    )
    return Object.entries(panels).flatMap(([key, panel]) => {
      const threadId = threadOf(key)
      if (threadId !== null && !live.has(threadId)) return []
      return panel.surfaces
        .filter((surface) => surface.kind === "browser")
        .map((surface) => ({ id: surface.id, slotKey: key, threadId, initialUrl: surface.url }))
    })
  }, [panels, threads, threadOf])

  return {
    slot,
    panels,
    rightOpen,
    rightStarted,
    rightMaximized,
    setRightMaximized,
    terminalOpen,
    setTerminalOpen,
    terminalStarted,
    terminalRecovery,
    browsers,
    updatePanel,
    toggleRight,
    toggleTerminal,
    browseProjectFiles,
    openSurface,
    openLinkTab,
  }
}

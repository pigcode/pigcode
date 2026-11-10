/**
 * 聊天页容器：从 store 读取线程与事件，把输入框里的操作（发送、切换 agent/模型、权限）交给 Host。
 * 线程头是一组标签：主会话、用户添加的子代理会话、主 agent 派生的子代理；输入框与中断、
 * 审批都作用在当前标签所在的会话上。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import type { PermissionMode, Thread } from "@pigcode/contracts"
import {
  contributionText,
  useAppStore,
  useContributions,
  type AppStore,
  type Connection,
} from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import { ChatView, collectSubagents, type ApprovalDecision } from "@pigcode/ui-chat"
import type { ComposerCommand, ComposerModelChoice } from "@pigcode/ui-composer"
import { OpenInButton } from "@pigcode/ui-shell"
import type { ClientPluginController } from "./client-plugins"
import { useAgentFeatures, useAgents, useModelCatalog } from "./agents"
import { NewThreadPage } from "./new-thread-page"
import {
  buildThreadTabs,
  childThreads,
  dismissSpawnedTab,
  openSpawnedTab,
  selectThreadTab,
  useThreadTabState,
  visibleSpawned,
} from "./thread-tabs"

/** 核心容器共享的依赖。 */
export interface CoreDeps {
  connection: Connection
  store: AppStore
  plugins: ClientPluginController
}

/** 聊天容器的右栏控制：线程头的切换按钮、文件与 Diff 标签的打开入口。 */
export interface ChatControls {
  rightOpen?: boolean
  onToggleRight?: () => void
  /** 线程头末尾的布局按钮；右栏展开时为 null，按钮在右栏标签栏里。 */
  layoutControls?: ReactNode
  /** 在右栏的文件标签里打开项目内的文件（相对路径）。 */
  onOpenFile?: (path: string) => void
  /** 在右栏打开 Diff。 */
  onOpenDiff?: () => void
  /** 每次进入新会话草稿都会变；变了就把光标放回草稿的输入框。 */
  draftFocus?: number
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 项目内的文件转成相对路径；项目外的文件不在文件标签里打开。 */
function projectRelative(path: string | undefined, root: string | undefined): string | undefined {
  if (!path) return undefined
  if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) return path
  if (!root) return undefined
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

/** 用 Host 返回的线程记录替换 store 里的同 id 线程。 */
function patchThread(store: AppStore, threadId: string, patch: Partial<Thread>): void {
  const threads = store
    .getSnapshot()
    .threads.map((item) => (item.id === threadId ? { ...item, ...patch } : item))
  store.update({ threads })
}

/** 聊天页容器。 */
export function ChatViewContainer({
  deps,
  rightOpen = false,
  onToggleRight,
  layoutControls,
  onOpenFile,
  onOpenDiff,
  draftFocus,
}: { deps: CoreDeps } & ChatControls) {
  const state = useAppStore(deps.store)
  const { t } = useLocale()
  // 输入框的 `/` 和命令面板用同一份 Command：下面只取登记了 slash 的那几条。
  const registeredCommands = useContributions("command")
  const active = state.threads.find((item) => item.id === state.activeThreadId) ?? null
  // 子代理不在侧栏里；从历史或命令面板落到子代理时，按它的主会话显示并选中它的标签。
  const main = active?.parentThreadId
    ? (state.threads.find((item) => item.id === active.parentThreadId) ?? active)
    : active
  const mainId = main?.id ?? null
  const project = state.projects.find((item) => item.id === main?.projectId)
  const connected = state.status === "connected"
  const agents = useAgents(deps.connection, state.agentRevision, connected)
  const featuresByAgent = useAgentFeatures(deps.connection, state.agentRevision, connected)
  const { catalog, load } = useModelCatalog(deps.connection, state.agentRevision, connected)
  const [notice, setNotice] = useState<string | null>(null)
  const tabState = useThreadTabState(mainId)
  const children = useMemo(() => childThreads(state.threads, mainId), [state.threads, mainId])
  const childKey = children.map((child) => child.id).join(",")

  useEffect(() => {
    if (!active?.parentThreadId || !mainId) return
    selectThreadTab(mainId, `agent:${active.id}`)
    deps.store.setActiveThread(mainId)
  }, [active, mainId, deps.store])

  // 子代理标签要显示运行状态，主会话打开时把它的子代理也订阅上。
  useEffect(() => {
    if (!connected || !childKey) return
    const open = new Set(deps.store.getSnapshot().openThreadIds)
    for (const childId of childKey.split(",")) {
      if (open.has(childId)) continue
      deps.store.openThread(childId)
      void deps.connection.openThread(childId).catch(() => undefined)
    }
  }, [connected, childKey, deps.store, deps.connection])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const fail = useCallback(
    (error: unknown) => deps.store.update({ error: messageOf(error) }),
    [deps.store],
  )

  const mainEvents = mainId ? (state.threadStates[mainId]?.events ?? state.events) : state.events
  const subagents = useMemo(() => collectSubagents(mainEvents), [mainEvents])
  const spawned = visibleSpawned(subagents, tabState)
  const selected = tabState.selected
  const viewChild = selected.startsWith("agent:")
    ? children.find((child) => `agent:${child.id}` === selected)
    : undefined
  const viewSubagent = selected.startsWith("spawned:")
    ? spawned.find((subagent) => `spawned:${subagent.id}` === selected)
    : undefined
  const thread = viewChild ?? main
  const threadId = thread?.id ?? null
  const viewState = threadId ? state.threadStates[threadId] : undefined
  const events = viewChild ? (viewState?.events ?? []) : mainEvents
  const streamingText = viewChild
    ? (viewState?.streamingText ?? "")
    : mainId
      ? (state.threadStates[mainId]?.streamingText ?? state.streamingText)
      : state.streamingText
  const liveOutput = viewChild
    ? viewState?.liveOutput
    : mainId
      ? state.threadStates[mainId]?.liveOutput
      : undefined
  const liveReasoning = viewChild
    ? (viewState?.liveReasoning ?? "")
    : mainId
      ? (state.threadStates[mainId]?.liveReasoning ?? "")
      : ""
  // Agent 功能按 driver 记；实例 id 与 driver id 相同时直接命中，否则按实例找到它的 driver。
  const viewInstanceId =
    thread?.lastInstanceId ??
    thread?.lastAgentId ??
    thread?.defaultInstanceId ??
    thread?.defaultAgentId ??
    null
  const viewAgentId =
    agents.find((agent) => agent.id === viewInstanceId)?.agentId ??
    thread?.lastAgentId ??
    thread?.defaultAgentId ??
    null
  const features = (viewAgentId ? featuresByAgent[viewAgentId] : undefined) ?? state.agentFeatures

  const statuses = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(state.threadStates).map(([id, value]) => [id, value.status]),
      ),
    [state.threadStates],
  )
  const tabs = main
    ? buildThreadTabs({ main, projectName: project?.name, children, statuses, spawned })
    : []
  const activeTabId = tabs.some((tab) => tab.id === selected) ? selected : "main"

  /** 当前会话最近一条带 runId 的事件所属的 run；中断与审批都作用在它上面。 */
  function latestRunId(): string | null {
    return [...events].reverse().find((event) => event.runId !== null)?.runId ?? null
  }

  function interrupt(): void {
    const runId = latestRunId()
    if (!runId || !threadId) return
    void deps.connection.call("run.interrupt", { threadId, runId }).catch(fail)
  }

  function respondApproval(requestId: string, decision: ApprovalDecision): void {
    const runId = latestRunId()
    if (!runId || !threadId) return
    void deps.connection
      .call("run.respondApproval", { threadId, runId, requestId, decision })
      .catch(fail)
  }

  function answerQuestion(requestId: string, answers: string[]): void {
    const runId = latestRunId()
    if (!runId || !threadId) return
    void deps.connection
      .call("run.answerQuestion", { threadId, runId, requestId, answers })
      .catch(fail)
  }

  /** 切换 Agent 实例与模型；换了实例时提示上下文以摘要交接。 */
  function selectModel(choice: ComposerModelChoice): void {
    if (!thread) return
    const previousInstance = thread.lastInstanceId ?? thread.defaultInstanceId ?? null
    void deps.connection
      .call("thread.switchAgent", {
        threadId: thread.id,
        agentId: choice.agentId,
        instanceId: choice.instanceId,
        modelId: choice.modelId,
      })
      .then(() => {
        patchThread(deps.store, thread.id, {
          lastAgentId: choice.agentId,
          lastInstanceId: choice.instanceId,
          lastModelId: choice.modelId,
        })
        if (choice.instanceId !== previousInstance) {
          const name =
            agents.find((agent) => agent.id === choice.instanceId)?.label ?? choice.instanceId
          setNotice(`${t("chat.agent.next")} ${name}`)
        }
      })
      .catch(fail)
  }

  function setPermissionMode(mode: PermissionMode): void {
    if (!thread) return
    patchThread(deps.store, thread.id, { permissionMode: mode })
    void deps.connection
      .call("thread.setPermissionMode", { threadId: thread.id, permissionMode: mode })
      .catch((error: unknown) => {
        patchThread(deps.store, thread.id, { permissionMode: thread.permissionMode })
        fail(error)
      })
  }

  /** 在主会话下添加一个子代理会话，并切到它的标签。 */
  function addSubagent(instanceId: string): void {
    if (!main) return
    const chosen = agents.find((agent) => agent.id === instanceId)
    const label = chosen?.label ?? instanceId
    void (async () => {
      const child = (await deps.connection.call("thread.create", {
        projectId: main.projectId,
        title: t("chat.subagent.defaultTitle").replace("{agent}", label),
        agentId: chosen?.agentId ?? instanceId,
        instanceId,
        parentThreadId: main.id,
      })) as Thread
      deps.store.update({ threads: [...deps.store.getSnapshot().threads, child] })
      deps.store.openThread(child.id, { loaded: true })
      selectThreadTab(main.id, `agent:${child.id}`)
      await deps.connection.openThread(child.id)
    })().catch(fail)
  }

  /** 关闭子代理标签：用户添加的归档（还在跑的 run 会停下），派生的只是不再显示。 */
  function closeTab(tabId: string): void {
    if (!mainId) return
    if (tabId.startsWith("spawned:")) {
      dismissSpawnedTab(mainId, tabId.slice("spawned:".length))
      return
    }
    if (!tabId.startsWith("agent:")) return
    const childId = tabId.slice("agent:".length)
    if (selected === tabId) selectThreadTab(mainId, "main")
    void deps.connection
      .call("thread.archive", { threadId: childId })
      .then((archived) => {
        patchThread(deps.store, childId, archived as Thread)
        deps.store.closeThread(childId)
        void deps.connection.closeThread(childId).catch(() => undefined)
      })
      .catch(fail)
  }

  const fileRoot = mainId
  const files = useMemo(
    () =>
      fileRoot
        ? async () => {
            const entries = (await deps.connection.call("workspace.tree", {
              threadId: fileRoot,
            })) as Array<{ path: string }>
            return entries.map((entry) => entry.path)
          }
        : undefined,
    [deps.connection, fileRoot],
  )

  const commands = useMemo<ComposerCommand[]>(
    () =>
      registeredCommands
        .filter((command) => command.slash !== undefined)
        .map((command) => ({
          // 加前缀：不和输入框自己的命令（model、permission-*）撞 id。
          id: `command-${command.id}`,
          label: `/${command.slash}`,
          description: contributionText(t, command.title),
          ...(command.keywords ? { keywords: command.keywords } : {}),
          // `/` 建议更新时才判断，不在这里缓存结果。
          available: command.available,
          run: () => void command.run(),
        })),
    [registeredCommands, t],
  )

  // 没有当前会话就是新会话草稿：发第一条消息时才建会话。
  if (!main) {
    return (
      <NewThreadPage
        deps={deps}
        agents={agents}
        catalog={catalog}
        onLoadModels={load}
        featuresByAgent={featuresByAgent}
        commands={commands}
        focusKey={draftFocus}
        layoutControls={layoutControls}
      />
    )
  }

  return (
    <>
      {notice ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className="toast">{notice}</div>
        </div>
      ) : null}
      <ChatView
        thread={thread}
        events={events}
        streamingText={streamingText}
        liveReasoning={liveReasoning}
        liveOutput={liveOutput}
        features={features}
        agents={agents}
        catalog={catalog}
        onLoadModels={load}
        {...(project ? { cwd: project.rootPath, projectName: project.name } : {})}
        loading={threadId !== null && !state.threadStates[threadId]?.loaded}
        onStart={(text, options) => {
          if (!threadId) return
          void deps.connection.startRun(threadId, text, options).catch(fail)
        }}
        onInterrupt={interrupt}
        onApproval={respondApproval}
        onAnswer={answerQuestion}
        {...(onOpenFile
          ? {
              onOpenFile: (target: string) => {
                const path = projectRelative(target, project?.rootPath)
                if (path) onOpenFile(path)
              },
            }
          : {})}
        {...(onOpenDiff ? { onViewDiff: () => onOpenDiff() } : {})}
        onSelectModel={selectModel}
        onPermissionMode={setPermissionMode}
        {...(files ? { files } : {})}
        commands={commands}
        rightOpen={rightOpen}
        {...(onToggleRight ? { onToggleRight } : {})}
        {...(layoutControls !== undefined ? { layoutControls } : {})}
        {...(project ? { openIn: <OpenInButton path={project.rootPath} /> } : {})}
        {...(main
          ? {
              tabs: {
                tabs,
                activeId: activeTabId,
                onSelect: (tabId: string) => selectThreadTab(main.id, tabId),
                onClose: closeTab,
                agents,
                onAdd: addSubagent,
              },
              onOpenSubagent: (subagentId: string) => openSpawnedTab(main.id, subagentId),
              onBackToMain: () => selectThreadTab(main.id, "main"),
            }
          : {})}
        subagent={viewSubagent ?? null}
        {...(viewChild
          ? { empty: { title: t("chat.subagent.emptyTitle"), hint: t("chat.subagent.emptyHint") } }
          : {})}
      />
    </>
  )
}

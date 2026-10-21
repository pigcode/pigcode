/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { useEffect, useRef, useState } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import {
  AppRenderer,
  SlotHost,
  useAppStore,
  type AppStore,
  type Connection,
  type SlotRegistry,
} from "@pigcode/client-runtime"
import {
  useAppearance,
  useLocale,
  type AppearanceController,
  type Locale,
} from "@pigcode/ui-primitives"
import { ChatView, type ApprovalDecision, type ProviderOption } from "@pigcode/ui-chat"
import type { SettingsSection, ShellView } from "@pigcode/ui-shell"
import { ThreadTabs, type ThreadTabStatus } from "@pigcode/ui-shell"
import type { ClientPluginController } from "./client-plugins"
import { PluginPanels } from "./client-plugins"
import { ConnectionBanner } from "./connection-banner"
import { listProviders, loadProviderContext, pickProviderId } from "./providers"
import { WorkbenchPanel } from "./workbench"

/** 核心容器共享的依赖。 */
export interface CoreDeps {
  connection: Connection
  store: AppStore
  plugins: ClientPluginController
}

/** chat.view slot 传入聊天容器的右栏控制；第三方聊天视图可以忽略。 */
export interface ChatSlotProps {
  rightOpen?: boolean
  onToggleRight?: () => void
  onNewThread?: () => void
}

/** settings.section slot 传给核心设置视图的属性。 */
export interface SettingsSlotProps {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onClose: () => void
  appearance: AppearanceController
}

/** App 的依赖。 */
export interface AppProps extends CoreDeps {
  slots: SlotRegistry
  locale: Locale
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 聊天页容器：从 store 读取线程与事件，把操作交给 connection。 */
export function ChatViewContainer({
  deps,
  rightOpen = false,
  onToggleRight,
  onNewThread,
}: { deps: CoreDeps } & ChatSlotProps) {
  const state = useAppStore(deps.store)
  const thread = state.threads.find((item) => item.id === state.activeThreadId) ?? null
  const project = state.projects.find((item) => item.id === thread?.projectId)
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])
  const { t } = useLocale()
  const [providerNotice, setProviderNotice] = useState<string | null>(null)

  // provider 列表只用于线程头切换入口；插件启停后按 revision 重新拉取。
  useEffect(() => {
    let cancelled = false
    void listProviders(deps.connection)
      .then((providers) => {
        if (!cancelled) {
          setProviderOptions(
            providers.map((provider) => ({ id: provider.id, displayName: provider.displayName })),
          )
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [deps.connection, state.providerRevision])

  function interrupt(): void {
    const runId = [...state.events].reverse().find((event) => event.runId !== null)?.runId
    if (!runId || !state.activeThreadId) return
    void deps.connection
      .call("run.interrupt", { threadId: state.activeThreadId, runId })
      .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
  }

  /** 把审批决议提交给 Host；runId 取最近一条带 runId 的事件。 */
  function respondApproval(requestId: string, decision: ApprovalDecision): void {
    const runId = [...state.events].reverse().find((event) => event.runId !== null)?.runId
    if (!runId || !state.activeThreadId) return
    void deps.connection
      .call("run.respondApproval", {
        threadId: state.activeThreadId,
        runId,
        requestId,
        decision,
      })
      .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
  }

  /** 切换 provider；Host 端语义由 Task 6 的 thread.switchProvider 落地。 */
  function switchProvider(providerId: string): void {
    if (!thread) return
    void deps.connection
      .call("thread.switchProvider", {
        threadId: thread.id,
        providerId,
        modelId: null,
      })
      .then(() => {
        const threads = deps.store
          .getSnapshot()
          .threads.map((item) =>
            item.id === thread.id
              ? { ...item, lastProviderId: providerId, lastModelId: null }
              : item,
          )
        deps.store.update({ threads })
        const name = providerOptions.find((provider) => provider.id === providerId)?.displayName
        setProviderNotice(`${t("chat.provider.next")} ${name ?? providerId}`)
        setTimeout(() => setProviderNotice(null), 4000)
      })
      .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
  }

  /** 切换模型；通过同一个 thread.switchProvider 命令交给 Host。 */
  function switchModel(modelId: string): void {
    if (!thread) return
    const providerId = thread.lastProviderId ?? thread.defaultProviderId
    void deps.connection
      .call("thread.switchProvider", {
        threadId: thread.id,
        providerId,
        modelId,
      })
      .then(() => {
        const threads = deps.store
          .getSnapshot()
          .threads.map((item) => (item.id === thread.id ? { ...item, lastModelId: modelId } : item))
        deps.store.update({ threads })
      })
      .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
  }

  // 多会话 tab 栏：标题来自线程列表，状态来自每个线程独立的 ThreadViewState。
  const openThreads = state.openThreadIds.flatMap(
    (id) => state.threads.find((item) => item.id === id) ?? [],
  )
  const statusByThread = Object.fromEntries(
    state.openThreadIds.map((id) => [id, state.threadStates[id]?.status ?? "idle"]),
  ) as Record<string, ThreadTabStatus>
  const tabs =
    openThreads.length > 0 ? (
      <ThreadTabs
        threads={openThreads}
        openThreadIds={state.openThreadIds}
        activeThreadId={state.activeThreadId}
        statusByThread={statusByThread}
        onActivate={(threadId) => deps.store.setActiveThread(threadId)}
        onClose={(threadId) => {
          deps.store.closeThread(threadId)
          void deps.connection
            .closeThread(threadId)
            .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
        }}
        {...(onNewThread ? { onNew: onNewThread } : {})}
      />
    ) : undefined

  return (
    <>
      {providerNotice ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className="toast">{providerNotice}</div>
        </div>
      ) : null}
      <ChatView
        thread={thread}
        events={state.events}
        streamingText={state.streamingText}
        tabs={tabs}
        capabilities={state.providerCapabilities}
        models={state.providerModels}
        providers={providerOptions}
        {...(project ? { cwd: project.rootPath } : {})}
        onStart={(text) => {
          if (!state.activeThreadId) return
          void deps.connection
            .startRun(state.activeThreadId, text)
            .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
        }}
        onInterrupt={interrupt}
        onApproval={respondApproval}
        onSwitchProvider={switchProvider}
        onSwitchModel={switchModel}
        rightOpen={rightOpen}
        {...(onToggleRight ? { onToggleRight } : {})}
      />
    </>
  )
}


/** 应用根组件。 */
export function App({ store, slots, connection, plugins, locale }: AppProps) {
  const state = useAppStore(store)
  const appearance = useAppearance()
  const [view, setView] = useState<ShellView>("chat")
  const [section, setSection] = useState<SettingsSection>("general")
  const [rightOpen, setRightOpen] = useState(false)
  const initialLoadDone = useRef(false)

  // 首次连上 Host 后拉取项目与线程；重连时保留当前界面状态。
  useEffect(() => {
    if (state.status !== "connected" || initialLoadDone.current) return
    initialLoadDone.current = true
    void (async () => {
      try {
        const projects = (await connection.call("project.list", {})) as Project[]
        const threads = (await connection.call("thread.list", {})) as Thread[]
        store.update({ projects, threads })
      } catch (error) {
        initialLoadDone.current = false
        store.update({ error: messageOf(error) })
      }
    })()
  }, [state.status, connection, store])

  // 当前线程变化时刷新能力与模型列表，驱动按 capability 隐藏控件。
  useEffect(() => {
    if (state.status !== "connected") return
    const thread = state.threads.find((item) => item.id === state.activeThreadId)
    if (!thread) return
    void loadProviderContext(connection, store, thread).catch((error: unknown) =>
      store.update({ error: messageOf(error) }),
    )
  }, [state.status, state.activeThreadId, state.threads, connection, store])

  async function addProject(path: string): Promise<void> {
    try {
      const project = (await connection.call("project.add", { rootPath: path })) as Project
      const current = store.getSnapshot()
      store.update({
        projects: [...current.projects, project],
        activeProjectId: project.id,
        error: null,
      })
    } catch (error) {
      store.update({ error: messageOf(error) })
    }
  }

  async function createThread(projectId?: string): Promise<void> {
    const snapshot = store.getSnapshot()
    const project = projectId
      ? snapshot.projects.find((item) => item.id === projectId)
      : snapshot.projects[0]
    if (!project) return
    try {
      const providerId = await pickProviderId(connection)
      const thread = (await connection.call("thread.create", {
        projectId: project.id,
        title: locale === "en-US" ? "New thread" : "新会话",
        providerId,
      })) as Thread
      store.update({
        threads: [thread, ...store.getSnapshot().threads],
        activeProjectId: project.id,
        error: null,
      })
      // 新线程立即成为 tab 与活动会话，再向 Host 订阅事件。
      store.openThread(thread.id)
      store.setActiveThread(thread.id)
      await connection.openThread(thread.id)
    } catch (error) {
      store.update({ error: messageOf(error) })
    }
  }

  function openThread(threadId: string): void {
    store.openThread(threadId)
    store.setActiveThread(threadId)
    void connection
      .openThread(threadId)
      .catch((error: unknown) => store.update({ error: messageOf(error) }))
  }

  const effectiveSection: SettingsSection = view === "plugins" ? "plugins" : section
  const threadStatus: Record<string, ThreadTabStatus> = {}
  for (const [threadId, viewState] of Object.entries(state.threadStates)) {
    threadStatus[threadId] = viewState.status
  }

  return (
    <AppRenderer
      locale={locale}
      view={view}
      projects={state.projects}
      threads={state.threads}
      activeThreadId={state.activeThreadId}
      threadStatus={threadStatus}
      onToggleRight={() => setRightOpen((value) => !value)}
      settingsSection={effectiveSection}
      onView={setView}
      onSettingsSection={setSection}
      onAddProject={(path) => void addProject(path)}
      onNewThread={(projectId) => void createThread(projectId)}
      onOpenThread={openThread}
      sidebarExtra={<PluginPanels controller={plugins} />}
      rightOpen={rightOpen}
      rightPanel={
        view === "chat" && state.activeThreadId ? (
          <WorkbenchPanel
            key={state.activeThreadId}
            connection={connection}
            threadId={state.activeThreadId}
            onClose={() => setRightOpen(false)}
            onError={(message) => store.update({ error: message })}
          />
        ) : undefined
      }
    >
      <ConnectionBanner store={store} />
      {view === "chat" ? (
        <SlotHost<ChatSlotProps>
          registry={slots}
          name="chat.view"
          props={{
            rightOpen,
            onToggleRight: () => setRightOpen((value) => !value),
            onNewThread: () => void createThread(),
          }}
        />
      ) : (
        <SlotHost<SettingsSlotProps>
          registry={slots}
          name="settings.section"
          props={{
            section: effectiveSection,
            onSection: setSection,
            onClose: () => setView("chat"),
            appearance,
          }}
        />
      )}
    </AppRenderer>
  )
}

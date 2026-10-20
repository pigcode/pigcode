/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { Project, ProviderCapabilities, Thread } from "@pigcode/contracts"
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
import { PluginManagerView, type PluginSummary } from "@pigcode/ui-plugin-manager"
import { SettingsView, type ProviderDetection, type ProviderStatus } from "@pigcode/ui-settings"
import type { SettingsSection, ShellView } from "@pigcode/ui-shell"
import type { ClientPluginController } from "./client-plugins"
import { PluginPanels } from "./client-plugins"

/** 核心容器共享的依赖。 */
export interface CoreDeps {
  connection: Connection
  store: AppStore
  plugins: ClientPluginController
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

/** provider.list 返回的一项；能力描述用于驱动 UI。 */
interface ProviderInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
}

/** provider.models 返回的模型条目；M2 只消费 id。 */
interface ProviderModelInfo {
  id: string
}

/** provider.detect 返回的 Codex 检测字段；authMethod 由 UI 层补空。 */
interface CodexDetection {
  installed: boolean
  version: string | null
  loggedIn: boolean
  command: string
  error: string | null
}

/** 读取 provider 列表。 */
async function listProviders(connection: Connection): Promise<ProviderInfo[]> {
  return (await connection.call("provider.list", {})) as ProviderInfo[]
}

/** 读取某个 provider 的模型目录并写入全局状态。 */
async function loadProviderModels(
  connection: Connection,
  store: AppStore,
  providerId: string,
): Promise<void> {
  const models = (await connection.call("provider.models", { providerId })) as ProviderModelInfo[]
  store.update({
    providerModels: models.flatMap((model) =>
      typeof model.id === "string" && model.id.length > 0 ? [model.id] : [],
    ),
  })
}

/** 按线程当前 provider 刷新能力与模型列表。 */
async function loadProviderContext(
  connection: Connection,
  store: AppStore,
  thread: Thread,
): Promise<void> {
  const providerId = thread.lastProviderId ?? thread.defaultProviderId
  // 切换线程时先清空上一线程的能力，避免短暂显示错误的控件。
  store.update({ providerCapabilities: null, providerModels: [] })
  const providers = await listProviders(connection)
  const capabilities = providers.find((provider) => provider.id === providerId)?.capabilities
  store.update({ providerCapabilities: capabilities ?? null })
  try {
    await loadProviderModels(connection, store, providerId)
  } catch {
    // 模型目录不可用时保留空列表，不阻塞聊天。
    store.update({ providerModels: [] })
  }
}

/** 把检测结果归一化为设置页的 provider 分区。 */
function toProviderStatus(
  id: string,
  displayName: string,
  detection: ProviderDetection,
  capabilities: ProviderCapabilities | undefined,
): ProviderStatus {
  return {
    id,
    displayName,
    installed: detection.installed,
    version: detection.version,
    loggedIn: detection.loggedIn,
    authMethod: detection.authMethod,
    subscriptionType: detection.subscriptionType ?? null,
    command: detection.command ?? null,
    error: detection.error ?? null,
    ...(capabilities ? { capabilities } : {}),
  }
}

/** 询问 Host 当前默认 provider；失败时回退到 fake。 */
async function pickProviderId(connection: Connection): Promise<string> {
  const result = (await connection.call("provider.default", {})) as { id?: unknown }
  return typeof result.id === "string" && result.id.length > 0 ? result.id : "fake"
}

/** 连接恢复后显示一条短提示；Host 被杀后由 main 重新转交端口触发。 */
function ConnectionBanner({ store }: { store: AppStore }) {
  const state = useAppStore(store)
  const { t } = useLocale()
  if (!state.reconnected) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <div className="toast">{t("status.reconnected")}</div>
    </div>
  )
}

/** 聊天页容器：从 store 读取线程与事件，把操作交给 connection。 */
export function ChatViewContainer({ deps }: { deps: CoreDeps }) {
  const state = useAppStore(deps.store)
  const thread = state.threads.find((item) => item.id === state.activeThreadId) ?? null
  const project = state.projects.find((item) => item.id === thread?.projectId)
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([])
  const { t } = useLocale()
  const [providerNotice, setProviderNotice] = useState<string | null>(null)

  // provider 列表只用于线程头切换入口；失败时保持为空，不影响聊天。
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
  }, [deps.connection])

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
        capabilities={state.providerCapabilities}
        models={state.providerModels}
        providers={providerOptions}
        {...(project ? { cwd: project.rootPath } : {})}
        onStart={(text) => {
          void deps.connection
            .startRun(text)
            .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
        }}
        onInterrupt={interrupt}
        onApproval={respondApproval}
        onSwitchProvider={switchProvider}
        onSwitchModel={switchModel}
      />
    </>
  )
}

/** 插件管理容器：列表来自 Host，安装/启停后同步重载 client bundle。 */
function PluginManagerContainer({ deps }: { deps: CoreDeps }) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await deps.connection.call("plugin.list", {})) as PluginSummary[]
    setPlugins(list)
  }, [deps.connection])

  useEffect(() => {
    void refresh().catch(() => setPlugins([]))
  }, [refresh])

  async function applyAndReload(action: () => Promise<unknown>): Promise<void> {
    await action()
    await refresh()
    await deps.plugins.reload()
  }

  return (
    <PluginManagerView
      plugins={plugins}
      onInstall={(sourceDir) =>
        applyAndReload(() => deps.connection.call("plugin.installLocal", { sourceDir }))
      }
      onEnable={(id) => applyAndReload(() => deps.connection.call("plugin.enable", { id }))}
      onDisable={(id) => applyAndReload(() => deps.connection.call("plugin.disable", { id }))}
      onRefresh={() => applyAndReload(async () => undefined)}
    />
  )
}

/** 设置容器：插件分区复用同一个插件管理视图。 */
export function SettingsContainer({
  deps,
  section,
  onSection,
  onClose,
  appearance,
}: SettingsSlotProps & { deps: CoreDeps }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([])

  /** 拉取 Claude/Codex 只读检测结果与能力，并刷新模型列表。 */
  const detect = useCallback(async (): Promise<void> => {
    try {
      const [detection, list] = await Promise.all([
        deps.connection.call("provider.detect", {}) as Promise<{
          claude: ProviderDetection
          codex: CodexDetection
        }>,
        listProviders(deps.connection),
      ])
      const capabilityOf = (id: string): ProviderCapabilities | undefined =>
        list.find((provider) => provider.id === id)?.capabilities
      const displayNameOf = (id: string, fallback: string): string =>
        list.find((provider) => provider.id === id)?.displayName ?? fallback

      setProviders([
        toProviderStatus(
          "claude",
          displayNameOf("claude", "Claude Code"),
          detection.claude,
          capabilityOf("claude"),
        ),
        toProviderStatus(
          "codex",
          displayNameOf("codex", "Codex"),
          {
            installed: detection.codex.installed,
            version: detection.codex.version,
            loggedIn: detection.codex.loggedIn,
            authMethod: null,
            command: detection.codex.command,
            error: detection.codex.error,
          },
          capabilityOf("codex"),
        ),
      ])

      // 用当前线程 provider 的模型目录填充 composer 的模型列表。
      const snapshot = deps.store.getSnapshot()
      const thread = snapshot.threads.find((item) => item.id === snapshot.activeThreadId)
      const providerId = thread?.lastProviderId ?? thread?.defaultProviderId
      if (providerId) await loadProviderModels(deps.connection, deps.store, providerId)
    } catch (error) {
      deps.store.update({ error: messageOf(error) })
    }
  }, [deps.connection, deps.store])

  // 进入设置页时检测一次；用户也可以点击按钮重新检测。
  useEffect(() => {
    void detect()
  }, [detect])

  return (
    <SettingsView
      section={section}
      onSection={onSection}
      onClose={onClose}
      appearance={appearance}
      providers={providers}
      onDetect={detect}
      pluginManager={<PluginManagerContainer deps={deps} />}
    />
  )
}

/** 应用根组件。 */
export function App({ store, slots, connection, plugins, locale }: AppProps) {
  const state = useAppStore(store)
  const appearance = useAppearance()
  const [view, setView] = useState<ShellView>("chat")
  const [section, setSection] = useState<SettingsSection>("general")
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
        activeThreadId: thread.id,
        events: [],
        streamingText: "",
        error: null,
      })
      await connection.openThread(thread.id)
    } catch (error) {
      store.update({ error: messageOf(error) })
    }
  }

  function openThread(threadId: string): void {
    store.update({ activeThreadId: threadId, events: [], streamingText: "", error: null })
    void connection
      .openThread(threadId)
      .catch((error: unknown) => store.update({ error: messageOf(error) }))
  }

  const effectiveSection: SettingsSection = view === "plugins" ? "plugins" : section

  return (
    <AppRenderer
      locale={locale}
      view={view}
      projects={state.projects}
      threads={state.threads}
      activeThreadId={state.activeThreadId}
      settingsSection={effectiveSection}
      onView={setView}
      onSettingsSection={setSection}
      onAddProject={(path) => void addProject(path)}
      onNewThread={(projectId) => void createThread(projectId)}
      onOpenThread={openThread}
      sidebarExtra={<PluginPanels controller={plugins} />}
    >
      <ConnectionBanner store={store} />
      {view === "chat" ? (
        <SlotHost registry={slots} name="chat.view" />
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

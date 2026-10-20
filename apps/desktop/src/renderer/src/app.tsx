/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { useCallback, useEffect, useRef, useState } from "react"
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
import { ChatView } from "@pigcode/ui-chat"
import { PluginManagerView, type PluginSummary } from "@pigcode/ui-plugin-manager"
import { SettingsView, fakeProvider } from "@pigcode/ui-settings"
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

  function interrupt(): void {
    const runId = [...state.events].reverse().find((event) => event.runId !== null)?.runId
    if (!runId || !state.activeThreadId) return
    void deps.connection
      .call("run.interrupt", { threadId: state.activeThreadId, runId })
      .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
  }

  return (
    <ChatView
      thread={thread}
      events={state.events}
      streamingText={state.streamingText}
      {...(project ? { cwd: project.rootPath } : {})}
      onStart={(text) => {
        void deps.connection
          .startRun(text)
          .catch((error: unknown) => deps.store.update({ error: messageOf(error) }))
      }}
      onInterrupt={interrupt}
      onApproval={() => undefined}
    />
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
  return (
    <SettingsView
      section={section}
      onSection={onSection}
      onClose={onClose}
      appearance={appearance}
      providers={[fakeProvider]}
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
      const thread = (await connection.call("thread.create", {
        projectId: project.id,
        title: locale === "en-US" ? "New thread" : "新会话",
        providerId: "fake",
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

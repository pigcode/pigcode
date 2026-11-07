/**
 * 新会话草稿页的容器：把项目、agent 与模型、权限接到草稿页；第一次发送时按草稿建会话，再把这条消息发出去。
 * 没发出去时文字放回输入框，不会丢。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { AgentFeatures } from "@pigcode/contracts"
import { useAppStore, useContributions } from "@pigcode/client-runtime"
import { NewThreadView } from "@pigcode/ui-chat"
import {
  prefillComposer,
  type ComposerAgent,
  type ComposerCommand,
  type ComposerModelCatalog,
  type ComposerSubmitOptions,
} from "@pigcode/ui-composer"
import { useLocale } from "@pigcode/ui-primitives"
import { OpenInButton } from "@pigcode/ui-shell"
import { useDefaultAgentId } from "./agents"
import type { CoreDeps } from "./chat-container"
import {
  NEW_THREAD_DRAFT_KEY,
  draftProjectId,
  materializeDraft,
  updateDraftOptions,
  useDraftOptions,
} from "./new-thread-draft"

/** 内置的「添加项目」命令；草稿页的项目菜单借它打开添加项目对话框。 */
const ADD_PROJECT_COMMAND = "add-project"

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NewThreadPage({
  deps,
  agents,
  catalog,
  onLoadModels,
  featuresByAgent,
  commands,
  focusKey,
  layoutControls,
}: {
  deps: CoreDeps
  agents: readonly ComposerAgent[]
  catalog: ComposerModelCatalog
  onLoadModels: (agentId: string) => void
  featuresByAgent: Readonly<Record<string, AgentFeatures>>
  commands: readonly ComposerCommand[]
  focusKey?: number | undefined
  layoutControls?: ReactNode
}) {
  const state = useAppStore(deps.store)
  const { locale } = useLocale()
  const registeredCommands = useContributions("command")
  const connected = state.status === "connected"
  const defaultAgentId = useDefaultAgentId(deps.connection, state.agentRevision, connected)
  const options = useDraftOptions()
  const [pending, setPending] = useState(false)
  const projectId = draftProjectId(state)
  const project = state.projects.find((item) => item.id === projectId)

  // 选过的 agent 停用或卸载以后退回默认 agent。
  const chosenGone =
    options.agentId !== null &&
    agents.length > 0 &&
    !agents.some((agent) => agent.id === options.agentId)
  useEffect(() => {
    if (chosenGone) updateDraftOptions({ agentId: null, modelId: null })
  }, [chosenGone])
  const agentId = (chosenGone ? null : options.agentId) ?? defaultAgentId
  const modelId = options.agentId && !chosenGone ? options.modelId : null
  const features = agentId ? featuresByAgent[agentId] : undefined

  const files = useMemo(
    () =>
      projectId
        ? async () => {
            const entries = (await deps.connection.call("project.files", {
              projectId,
            })) as Array<{ path: string }>
            return entries.map((entry) => entry.path)
          }
        : undefined,
    [deps.connection, projectId],
  )

  async function submit(text: string, submitOptions: ComposerSubmitOptions): Promise<void> {
    if (pending) return
    setPending(true)
    let threadId: string | null = null
    try {
      threadId = (await materializeDraft(deps.connection, deps.store, locale)).id
      await deps.connection.startRun(
        threadId,
        text,
        submitOptions.effort ? { effort: submitOptions.effort } : {},
      )
    } catch (error) {
      // 还没建成会话时放回草稿；建成了就放进新会话的输入框。
      prefillComposer(threadId ?? NEW_THREAD_DRAFT_KEY, { text })
      deps.store.update({ error: messageOf(error) })
    } finally {
      setPending(false)
    }
  }

  return (
    <NewThreadView
      projects={state.projects}
      projectId={projectId}
      onSelectProject={(id) => deps.store.update({ activeProjectId: id })}
      onAddProject={() =>
        void registeredCommands.find((command) => command.id === ADD_PROJECT_COMMAND)?.run()
      }
      draftKey={NEW_THREAD_DRAFT_KEY}
      agents={agents}
      catalog={catalog}
      onLoadModels={onLoadModels}
      agentId={agentId}
      modelId={modelId}
      onSelectModel={(agent, model) => updateDraftOptions({ agentId: agent, modelId: model })}
      permissionMode={options.permissionMode}
      onPermissionMode={(mode) => updateDraftOptions({ permissionMode: mode })}
      canPlan={features?.plan ?? true}
      {...(files ? { files } : {})}
      commands={commands}
      onSubmit={(text, submitOptions) => void submit(text, submitOptions)}
      pending={pending}
      {...(focusKey !== undefined ? { focusKey } : {})}
      {...(project ? { openIn: <OpenInButton path={project.rootPath} /> } : {})}
      layoutControls={layoutControls}
    />
  )
}

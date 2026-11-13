import { DEFAULT_RUNTIME_MODE } from "@pigcode/contracts"
/**
 * 新会话草稿页的容器：把项目、agent 与模型、权限接到草稿页；第一次发送时按草稿建会话，再把这条消息发出去。
 * 没发出去时文字放回输入框，不会丢。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useThreadOptions } from "./thread-options"
import type { AgentFeatures, GitBranches, WorktreeStart } from "@pigcode/contracts"
import { useAppStore, useContributions } from "@pigcode/client-runtime"
import { NewThreadView } from "@pigcode/ui-chat"
import {
  captureComposerDraft,
  type ComposerAgent,
  type ComposerCommand,
  type ComposerModelCatalog,
  type ComposerSubmitOptions,
} from "@pigcode/ui-composer"
import { useLocale } from "@pigcode/ui-primitives"
import { OpenInButton } from "@pigcode/ui-shell"
import { useAgentCommandsLoader } from "./agent-commands"
import { useDefaultInstanceId } from "./agents"
import type { CoreDeps } from "./chat-container"
import { DraftWorkspaceControls } from "./draft-workspace-controls"
import { useDraftBranches } from "./use-draft-branches"
import {
  NEW_THREAD_DRAFT_KEY,
  draftProjectId,
  materializeDraft,
  updateDraftOptions,
  selectDraftAgent,
  useDraftOptions,
} from "./new-thread-draft"

/** 内置的「添加项目」命令；草稿页的项目菜单借它打开添加项目对话框。 */
const ADD_PROJECT_COMMAND = "add-project"

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface NewThreadPageProps {
  deps: CoreDeps
  agents: readonly ComposerAgent[]
  catalog: ComposerModelCatalog
  onLoadModels: (agentId: string) => void
  featuresByAgent: Readonly<Record<string, AgentFeatures>>
  commands: readonly ComposerCommand[]
  focusKey?: number | undefined
  layoutControls?: ReactNode
  onBranchChanged?: (() => void) | undefined
}

export function NewThreadPage(props: NewThreadPageProps) {
  const state = useAppStore(props.deps.store)
  const projectId = draftProjectId(state)
  return <ProjectDraft key={projectId} {...props} projectId={projectId} />
}

function ProjectDraft({
  deps,
  agents,
  catalog,
  onLoadModels,
  commands,
  focusKey,
  layoutControls,
  onBranchChanged,
  projectId,
}: NewThreadPageProps & { projectId: string | null }) {
  const state = useAppStore(deps.store)
  const { locale, t } = useLocale()
  const registeredCommands = useContributions("command")
  const connected = state.status === "connected"
  const defaultInstanceId = useDefaultInstanceId(deps.connection, state.agentRevision, connected)
  const options = useDraftOptions()
  const [pending, setPending] = useState(false)
  const [worktree, setWorktree] = useState<WorktreeStart | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const busy = useRef(false)
  const project = state.projects.find((item) => item.id === projectId)
  const git = useDraftBranches(deps.connection, connected ? projectId : null)
  const needsBase = worktree !== null && !worktree.baseRef && !git.branches?.head
  const threadChoices = useThreadOptions(state.threads, state.projects, null, projectId)

  // 选过的实例停用、删除或卸载以后退回默认实例。
  const chosenGone =
    options.instanceId !== null &&
    agents.length > 0 &&
    !agents.some((agent) => agent.id === options.instanceId)
  useEffect(() => {
    if (chosenGone)
      updateDraftOptions({
        instanceId: null,
        agentId: null,
        modelId: null,
      })
  }, [chosenGone])
  const instanceId = (chosenGone ? null : options.instanceId) ?? defaultInstanceId
  const modelId = options.instanceId && !chosenGone ? options.modelId : null
  const selectedAgent = agents.find((agent) => agent.id === instanceId)

  const loadAgentCommands = useAgentCommandsLoader(
    deps.connection,
    projectId ? { projectId } : null,
  )
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
    if (busy.current) return
    busy.current = true
    const restore = captureComposerDraft(NEW_THREAD_DRAFT_KEY)
    setPending(true)
    setFailure(null)
    let threadId: string | null = null
    try {
      threadId = (await materializeDraft(deps.connection, deps.store, locale, worktree)).id
      await deps.connection.openThread(threadId)
      await deps.connection.startRun(threadId, text, submitOptions)
    } catch (error) {
      // 还没建成会话时放回草稿；建成了就放进新会话的输入框。
      restore(threadId ?? NEW_THREAD_DRAFT_KEY)
      if (worktree && !threadId) setFailure(messageOf(error))
      else deps.store.update({ error: messageOf(error) })
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  async function changeBranch(method: "git.switchBranch" | "git.createBranch", branch: string) {
    if (!projectId || busy.current) return
    busy.current = true
    setSwitching(true)
    try {
      const next = (await deps.connection.call(method, { projectId, branch })) as GitBranches | null
      git.accept(next)
      onBranchChanged?.()
    } catch (error) {
      void git.refresh()
      throw error
    } finally {
      busy.current = false
      setSwitching(false)
    }
  }

  const workspaceStatus =
    pending && worktree ? (
      <p className="draft-workspace-status" role="status">
        {t("newThread.worktree.creating")}
      </p>
    ) : failure ? (
      <div className="draft-workspace-status error-text" role="alert">
        <span>{t("newThread.worktree.failed")}</span>
        <span>{failure}</span>
      </div>
    ) : git.error && !git.branches ? (
      <p className="draft-workspace-status hint" title={git.error}>
        {t("newThread.branch.loadFailed")}
      </p>
    ) : null

  return (
    <NewThreadView
      projects={state.projects}
      projectId={projectId}
      onSelectProject={(id) => deps.store.update({ activeProjectId: id })}
      onAddProject={() =>
        void registeredCommands.find((command) => command.id === ADD_PROJECT_COMMAND)?.run()
      }
      workspaceControls={
        project ? (
          <DraftWorkspaceControls
            branches={git.branches}
            worktree={worktree}
            disabled={!connected || pending || switching}
            onOpenBranches={() => void git.refresh()}
            onSwitchBranch={(branch) =>
              void changeBranch("git.switchBranch", branch).catch((error: unknown) =>
                deps.store.update({ error: messageOf(error) }),
              )
            }
            onWorktree={(next) => {
              setWorktree(next)
              setFailure(null)
            }}
            onCreateBranch={(branch) => changeBranch("git.createBranch", branch)}
          />
        ) : null
      }
      workspaceStatus={workspaceStatus}
      draftKey={NEW_THREAD_DRAFT_KEY}
      agents={agents}
      catalog={catalog}
      onLoadModels={onLoadModels}
      agentId={instanceId}
      modelId={modelId}
      onSelectModel={selectDraftAgent}
      permissionMode={options.permissionMode ?? DEFAULT_RUNTIME_MODE}
      onPermissionMode={(mode) =>
        updateDraftOptions({
          permissionMode: mode,
          instanceId,
          agentId: selectedAgent?.agentId ?? null,
        })
      }
      planMode={options.planMode ?? false}
      onPlanMode={(planMode) =>
        updateDraftOptions({ planMode, instanceId, agentId: selectedAgent?.agentId ?? null })
      }
      {...(files ? { files } : {})}
      threads={threadChoices}
      commands={commands}
      loadAgentCommands={loadAgentCommands}
      onSubmit={(text, submitOptions) => void submit(text, submitOptions)}
      pending={pending || switching || needsBase}
      {...(focusKey !== undefined ? { focusKey } : {})}
      {...(project ? { openIn: <OpenInButton path={project.rootPath} /> } : {})}
      layoutControls={layoutControls}
    />
  )
}

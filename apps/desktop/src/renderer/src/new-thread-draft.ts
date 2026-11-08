/**
 * 新会话草稿（参照 ZCode 的新建任务）：点「新会话」、⌘N 或项目行的加号只进入草稿，不在 Host 上建会话，
 * 侧栏里也没有它。草稿的项目是 store 里的 activeProjectId；agent、模型与权限记在这里，本次运行内一直沿用。
 * 第一次发送，或者打开必须挂在会话上的右栏与终端时，才按草稿建会话。
 */
import { useSyncExternalStore } from "react"
import type { PermissionMode, Thread } from "@pigcode/contracts"
import type { AppState, AppStore, Connection } from "@pigcode/client-runtime"
import { moveComposerDraft } from "@pigcode/ui-composer"
import { translate, type Locale } from "@pigcode/ui-primitives"
import { pickAgentId } from "./agent-context"

/** 草稿输入框的键：草稿的文字和附件按它记在输入框的记忆里。 */
export const NEW_THREAD_DRAFT_KEY = "new-thread"

/** 草稿里选好的 Agent 实例、模型与权限；instanceId 为 null 时用默认实例和它的默认模型。 */
export interface DraftOptions {
  /** Agent 实例 id；默认实例等于 agent id。 */
  instanceId: string | null
  /** 实例所属的 Agent（driver id）；随实例一起记下，建会话时一起交给 Host。 */
  agentId: string | null
  modelId: string | null
  permissionMode: PermissionMode
}

const DEFAULT_OPTIONS: DraftOptions = {
  instanceId: null,
  agentId: null,
  modelId: null,
  permissionMode: "workspace-write",
}

let options: DraftOptions = DEFAULT_OPTIONS
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 读当前的草稿选项。 */
export function draftOptions(): DraftOptions {
  return options
}

/** 改草稿选项。 */
export function updateDraftOptions(patch: Partial<DraftOptions>): void {
  options = { ...options, ...patch }
  for (const listener of listeners) listener()
}

/** 测试用：回到默认选项。 */
export function resetDraftOptions(): void {
  updateDraftOptions(DEFAULT_OPTIONS)
}

/** 订阅草稿选项。 */
export function useDraftOptions(): DraftOptions {
  return useSyncExternalStore(subscribe, draftOptions)
}

/** 草稿要落到的项目：最近用过的项目还在就是它，否则第一个项目；一个项目都没有时为 null。 */
export function draftProjectId(
  state: Pick<AppState, "projects" | "activeProjectId">,
): string | null {
  const recent = state.projects.find((project) => project.id === state.activeProjectId)
  return (recent ?? state.projects[0])?.id ?? null
}

/**
 * 按草稿在 Host 上建会话并打开它，成为当前会话；侧栏这时才出现这一行。草稿输入框里还没发的文字和附件
 * 跟着搬进新会话的输入框（打开右栏、终端时建的会话）；发送时建的会话，文字已经发出去了。
 */
export async function materializeDraft(
  connection: Connection,
  store: AppStore,
  locale: Locale,
): Promise<Thread> {
  const projectId = draftProjectId(store.getSnapshot())
  if (!projectId) throw new Error(translate(locale, "newThread.noProject"))
  const chosen = draftOptions()
  const agentId = chosen.agentId ?? (await pickAgentId(connection))
  if (!agentId) throw new Error(translate(locale, "app.noAgent"))
  const instanceId = chosen.instanceId ?? agentId
  const thread = (await connection.call("thread.create", {
    projectId,
    title: translate(locale, "thread.defaultTitle"),
    agentId,
    instanceId,
    ...(chosen.modelId ? { modelId: chosen.modelId } : {}),
    ...(chosen.permissionMode !== DEFAULT_OPTIONS.permissionMode
      ? { permissionMode: chosen.permissionMode }
      : {}),
  })) as Thread
  // 草稿页还挂着时就搬：它的输入框先交出正在写的内容。
  moveComposerDraft(NEW_THREAD_DRAFT_KEY, thread.id)
  store.update({
    threads: [thread, ...store.getSnapshot().threads],
    activeProjectId: projectId,
    error: null,
  })
  store.openThread(thread.id, { loaded: true })
  store.setActiveThread(thread.id)
  await connection.openThread(thread.id)
  return thread
}

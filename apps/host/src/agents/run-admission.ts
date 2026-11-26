import { randomUUID } from "node:crypto"
import type {
  AgentModeSelection,
  ImageAttachmentRef,
  Thread,
  ThreadEvent,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { threadCwd } from "../services/worktrees"
import type { RunStore } from "../storage/run-store"
import type { AgentDriver, UserImageAttachment } from "./driver"
import type { QueuedRun } from "./run-queue"
import { runInput, type StartRunOptions } from "./service"
import type { AgentSessionStore } from "./session-store"
import { pendingForkFromNativeSessionId } from "./switching"
import { registerThreadReadTool } from "./thread-read-tool"
import { recordThreadReferences } from "./thread-reference"
import { maybeAutoTitle } from "./title"

interface RunPreparation {
  thread: Thread
  driver: AgentDriver
  instanceId: string
  modes: AgentModeSelection
  text: string
  emitLive: QueuedRun["emitLive"]
  options: StartRunOptions
}

export function prepareRunEntry(
  ctx: Context,
  agentSessions: AgentSessionStore,
  { thread, driver, instanceId, modes, text, emitLive, options }: RunPreparation,
): QueuedRun {
  const threadId = thread.id
  const cwd = threadCwd(ctx, threadId)
  const previous =
    agentSessions.findActive(threadId, driver.id, instanceId) ??
    agentSessions.findResumable(threadId, driver.id, instanceId)
  const session =
    previous?.cwd === cwd
      ? previous
      : agentSessions.findResumable(threadId, driver.id, instanceId, cwd)
  const forkFrom = pendingForkFromNativeSessionId(ctx, threadId)
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const bridge = ctx.reflect.get("mcpBridge")
  if (bridge) {
    const unregister = registerThreadReadTool(ctx, bridge)
    if (unregister) ctx.effect(() => unregister)
  }
  const mcp = bridge?.sessionMcp(threadId)
  const source = options.admission
  return {
    runId: source?.runId ?? `run_${randomUUID()}`,
    threadId,
    ...(source?.deviceKey ? { sourceDevice: source.deviceKey } : {}),
    ...(source?.isAuthorized ? { isAuthorized: source.isAuthorized } : {}),
    driver,
    instanceId,
    input: runInput(text, options),
    emitLive,
    controller: new AbortController(),
    done,
    resolveDone,
    queuedAt: new Date().toISOString(),
    cwd,
    ...(previous && !session ? { workspaceChanged: true } : {}),
    ...modes,
    model: thread.lastModelId,
    nativeSessionId: forkFrom ? null : (session?.nativeSessionId ?? null),
    ...(forkFrom ? { forkFromNativeSessionId: forkFrom } : {}),
    ...(session ? { sessionId: session.id } : {}),
    ...(mcp ? { mcp } : {}),
  }
}

/** 写入 run 和首条输入。手机调用方在同一事务写入命令回执。 */
export function writeRunAdmission(
  ctx: Context,
  runs: RunStore,
  thread: Thread,
  entry: QueuedRun,
  queued: boolean,
  options: StartRunOptions,
  append: (
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ) => void,
): void {
  const { runId, threadId, queuedAt } = entry
  const { text } = entry.input
  let resolvedAttachments: readonly UserImageAttachment[] = entry.input.attachments ?? []
  if (options.attachmentIds && options.attachmentIds.length > 0) {
    const attachmentsService = ctx.get("attachments")
    if (!attachmentsService) throw new Error("attachments service is not available")
    resolvedAttachments = attachmentsService.commitForThread(
      options.attachmentIds,
      threadId,
      options.admission?.deviceKey ?? null,
    )
    entry.input = { ...entry.input, attachments: resolvedAttachments }
  }
  const attachmentRefs: ImageAttachmentRef[] = resolvedAttachments.map(
    ({ id, mimeType, fileName, sizeBytes, width, height }) => ({
      id,
      mimeType,
      fileName,
      sizeBytes,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }),
  )
  const awaitingAgent = queued || options.admission?.deviceKey !== undefined
  if (options.admission?.deviceKey && thread.archivedAt) {
    ctx.threads.unarchive(threadId)
    append(threadId, null, "thread.updated", { archivedAt: null })
  }
  // 排队时不创建原生 Agent 会话。
  runs.create({
    id: runId,
    threadId,
    agentSessionId: "pending",
    status: awaitingAgent ? "queued" : "running",
    startedAt: queuedAt,
  })
  maybeAutoTitle(ctx, thread, text, runId, append, attachmentRefs)
  const references = recordThreadReferences(ctx, threadId, options.references ?? [])
  append(threadId, runId, "message.completed", {
    role: "user",
    text,
    ...(references.length > 0 ? { references } : {}),
    ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
  })
  if (awaitingAgent) append(threadId, runId, "run.queued", { queuedAt })
  options.admission?.recordReceipt(runId)
}

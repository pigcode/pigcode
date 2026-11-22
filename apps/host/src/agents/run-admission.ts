import type { Thread, ThreadEvent } from "@pigcode/contracts"
import type { Context } from "cordis"
import type { RunStore } from "../storage/run-store"
import type { QueuedRun } from "./run-queue"
import type { StartRunOptions } from "./service"
import { recordThreadReferences } from "./thread-reference"
import { maybeAutoTitle } from "./title"

/** Mobile admission commits the receipt, the run and the input before the driver starts. */
export function persistRunAdmission(
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
): () => void {
  const { runId, threadId, queuedAt } = entry
  const { text } = entry.input
  const awaitingAgent = queued || options.mobileAdmission !== undefined
  const write = () => {
    if (options.mobileAdmission && thread.archivedAt) {
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
    maybeAutoTitle(ctx, thread, text, runId, append)
    const references = recordThreadReferences(ctx, threadId, options.references ?? [])
    append(threadId, runId, "message.completed", {
      role: "user",
      text,
      ...(references.length > 0 ? { references } : {}),
    })
    if (awaitingAgent) append(threadId, runId, "run.queued", { queuedAt })
    options.mobileAdmission?.recordReceipt(runId)
  }

  if (options.mobileAdmission) return ctx.sessions.stageEvents(write)
  write()
  return () => {}
}

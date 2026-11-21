/** 会话记录的 RPC 命令：列出、改名、归档与取消归档、标为已读；改过的会话交给 changed 推给页面。 */
import type { Context } from "cordis"
import type { CommandMethod, Thread } from "@pigcode/contracts"

export const THREAD_COMMANDS = new Set<CommandMethod>([
  "thread.list",
  "thread.rename",
  "thread.archive",
  "thread.unarchive",
  "thread.markRead",
  "thread.markAllRead",
])

function found(thread: Thread | undefined, threadId: string): Thread {
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  return thread
}

export function dispatchThreadCommand(
  ctx: Context,
  command: CommandMethod,
  parsed: unknown,
  changed: (threadId: string) => void,
): unknown {
  switch (command) {
    case "thread.list":
      return ctx.threads.list((parsed as { projectId?: string }).projectId)
    case "thread.rename": {
      const value = parsed as { threadId: string; title: string }
      const thread = found(ctx.threads.rename(value.threadId, value.title), value.threadId)
      ctx.sessions.append({
        threadId: thread.id,
        runId: null,
        type: "thread.updated",
        payload: { title: thread.title },
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
      })
      return thread
    }
    case "thread.archive": {
      const value = parsed as { threadId: string }
      // 归档的会话从界面上消失；还在跑或排队的 run 先停下，免得在看不见的地方改代码或卡在审批上。
      // 子代理随主会话一起归档，它们的 run 也一并停下。
      const archived = new Set([
        value.threadId,
        ...ctx.threads.children(value.threadId).map((child) => child.id),
      ])
      for (const run of ctx.agents.listRuns()) {
        if (archived.has(run.threadId)) ctx.agents.cancelRun(run.runId)
      }
      // 终端也一样：归档后没有界面能关它，里面的进程会一直跑下去。
      for (const threadId of archived) ctx.get("terminal")?.closeThread(threadId)
      const thread = found(ctx.threads.archive(value.threadId), value.threadId)
      for (const threadId of archived) changed(threadId)
      return thread
    }
    case "thread.unarchive": {
      const value = parsed as { threadId: string }
      const thread = found(ctx.threads.unarchive(value.threadId), value.threadId)
      changed(thread.id)
      for (const child of ctx.threads.children(thread.id)) changed(child.id)
      return thread
    }
    case "thread.markRead": {
      const value = parsed as { threadId: string; read: boolean }
      const thread = found(ctx.threads.markRead(value.threadId, value.read), value.threadId)
      changed(thread.id)
      return thread
    }
    case "thread.markAllRead": {
      const threads = ctx.threads.markAllRead()
      for (const thread of threads) changed(thread.id)
      return threads
    }
    default:
      throw new Error(`unsupported method: ${command}`)
  }
}

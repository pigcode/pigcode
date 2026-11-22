/** 新会话可在独立 worktree 启动。先准备 Git 目录，再同时写入会话和活动 worktree。 */
import { modesForAgent, resolveModes } from "../agents/execution-modes"
import { randomUUID } from "node:crypto"
import type { Context } from "cordis"
import type { CommandParams, Thread } from "@pigcode/contracts"
import { recordSubagentBrief } from "../agents/switching"
import { scopeCwd } from "./worktrees"

export function appendThreadCreated(ctx: Context, thread: Thread): void {
  const { id, title, parentThreadId, createdAt } = thread
  ctx.sessions.append({
    threadId: id,
    runId: null,
    type: "thread.created",
    payload: { title, ...(parentThreadId ? { parentThreadId } : {}) },
    schemaVersion: 1,
    createdAt,
  })
}

export async function createThread(
  ctx: Context,
  value: CommandParams<"thread.create">,
): Promise<Thread> {
  const { projectId, title, agentId, parentThreadId, worktree } = value
  const parent = parentThreadId ? ctx.threads.get(parentThreadId) : undefined
  const modes = resolveModes(
    modesForAgent(ctx, agentId, value.instanceId),
    {
      permissionMode: value.permissionMode ?? parent?.permissionMode,
      planMode: value.planMode ?? parent?.planMode,
    },
    agentId,
  )
  if (parentThreadId && worktree) throw new Error("A sub-agent uses its parent thread's workspace")
  if (worktree) scopeCwd(ctx, { projectId })
  const id = worktree ? `th_${randomUUID()}` : undefined
  const prepared = worktree && id ? await ctx.worktrees.prepare(projectId, id, worktree) : null

  try {
    return ctx.storage.db.transaction(() => {
      if (prepared) scopeCwd(ctx, { projectId })
      const thread = ctx.threads.create(projectId, title, agentId, parentThreadId, {
        id,
        instanceId: value.instanceId,
        modelId: value.modelId,
        ...modes,
      })
      prepared?.persist()
      appendThreadCreated(ctx, thread)
      if (parentThreadId) recordSubagentBrief(ctx, thread.id, parentThreadId)
      return thread
    })()
  } catch (error) {
    await prepared?.rollback()
    throw error
  }
}

/** 定时任务触发时解析项目和 Agent 实例，再走普通的新建会话路径。 */
import { stat } from "node:fs/promises"
import type { ProjectScheduleTarget, Thread } from "@pigcode/contracts"
import type { Context } from "cordis"
import { createThread } from "./thread-create"

export async function createScheduledThread(
  ctx: Context,
  { projectId, execution }: ProjectScheduleTarget,
  title: string,
): Promise<Thread> {
  const { instanceId, modelId, permissionMode } = execution
  const instance = instanceId ? ctx.agents.findInstance(instanceId) : null
  if (instanceId && !instance?.enabled) throw new Error("AGENT_UNAVAILABLE")
  const selected = instance ?? (await ctx.agents.defaultAgent())
  if (
    !selected.agentId ||
    !selected.instanceId ||
    !ctx.agents.list().some((agent) => agent.id === selected.agentId)
  ) {
    throw new Error("AGENT_UNAVAILABLE")
  }
  const project = ctx.projects.list().find((item) => item.id === projectId)
  if (!project || !(await stat(project.rootPath).catch(() => null))?.isDirectory()) {
    throw new Error("PROJECT_UNAVAILABLE")
  }
  return createThread(ctx, {
    projectId,
    title,
    agentId: selected.agentId,
    instanceId: selected.instanceId,
    modelId,
    permissionMode,
  })
}

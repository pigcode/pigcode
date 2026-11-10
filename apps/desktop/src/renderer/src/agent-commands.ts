/**
 * 输入框 `/` 菜单里 Agent 的命令与 skill：按实例与工作目录（线程或项目）读 `agent.commands`。
 * Host 自己按实例与目录缓存十分钟；这里再记两分钟，输入框每次获得焦点、每敲一个字都不用再问 Host。
 * 读失败或读到空列表不记，CLI 稍后装好或登录后能立刻看到。
 */
import { useCallback } from "react"
import type { AgentCommand } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"

const TTL_MS = 2 * 60_000

const cache = new Map<string, { request: Promise<AgentCommand[]>; at: number }>()

/** 测试用：清空记住的结果。 */
export function resetAgentCommandsCache(): void {
  cache.clear()
}

/** 命令的工作目录：已有会话按线程，新会话草稿按项目。 */
export type AgentCommandScope = { threadId: string } | { projectId: string } | null

/** 返回按实例读命令的函数；scope 变了函数才变。 */
export function useAgentCommandsLoader(
  connection: Connection,
  scope: AgentCommandScope,
): (instanceId: string) => Promise<AgentCommand[]> {
  const threadId = scope && "threadId" in scope ? scope.threadId : null
  const projectId = scope && "projectId" in scope ? scope.projectId : null
  return useCallback(
    (instanceId: string) => {
      const key = JSON.stringify([instanceId, threadId, projectId])
      const cached = cache.get(key)
      if (cached && Date.now() - cached.at < TTL_MS) return cached.request
      const request = (
        connection.call("agent.commands", {
          instanceId,
          ...(threadId ? { threadId } : projectId ? { projectId } : {}),
        }) as Promise<AgentCommand[]>
      ).then(
        (commands) => {
          if (commands.length === 0) cache.delete(key)
          return commands
        },
        (): AgentCommand[] => {
          cache.delete(key)
          return []
        },
      )
      cache.set(key, { request, at: Date.now() })
      return request
    },
    [connection, threadId, projectId],
  )
}

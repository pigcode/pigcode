/**
 * 按连接、实例与工作目录缓存 Agent 目录。聚焦预取，打开 `/` 或 `$` 时刷新；
 * 一次菜单内的输入共享读取结果，新安装的 Skill 无需重启或等待缓存过期。
 */
import { useCallback } from "react"
import type { AgentCommand } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"

const TTL_MS = 2 * 60_000

interface Entry {
  request: Promise<AgentCommand[]>
  at: number
  pending: boolean
  refresh: boolean
}
let caches = new WeakMap<Connection, Map<string, Entry>>()

/** 测试用：清空记住的结果。 */
export function resetAgentCommandsCache(): void {
  caches = new WeakMap()
}

/** 命令的工作目录：已有会话按线程，新会话草稿按项目。 */
export type AgentCommandScope = { threadId: string } | { projectId: string } | null

/** 返回按实例读命令的函数；scope 变了函数才变。 */
export function useAgentCommandsLoader(
  connection: Connection,
  scope: AgentCommandScope,
): (instanceId: string, refresh?: boolean) => Promise<AgentCommand[]> {
  const threadId = scope && "threadId" in scope ? scope.threadId : null
  const projectId = scope && "projectId" in scope ? scope.projectId : null
  return useCallback(
    (instanceId: string, refresh = false) => {
      let cache = caches.get(connection)
      if (!cache) {
        cache = new Map()
        caches.set(connection, cache)
      }
      const key = JSON.stringify([instanceId, threadId, projectId])
      const cached = cache.get(key)
      if (
        cached &&
        ((cached.pending && (!refresh || cached.refresh)) ||
          (!refresh && Date.now() - cached.at < TTL_MS))
      )
        return cached.request
      const entries = cache
      const request = (
        connection.call("agent.commands", {
          instanceId,
          ...(threadId ? { threadId } : projectId ? { projectId } : {}),
          ...(refresh ? { refresh: true } : {}),
        }) as Promise<AgentCommand[]>
      ).then(
        (commands) => {
          if (entries.get(key)?.request === request) {
            if (commands.length === 0) entries.delete(key)
            else entries.set(key, { request, at: Date.now(), pending: false, refresh })
          }
          return commands
        },
        (): AgentCommand[] => {
          if (entries.get(key)?.request === request) entries.delete(key)
          return []
        },
      )
      cache.set(key, { request, at: Date.now(), pending: true, refresh })
      return request
    },
    [connection, threadId, projectId],
  )
}

/** 已注册的 agent、它们的 Agent 功能与默认实例的查询辅助；供聊天与设置容器共用。 */
import type { AgentFeatures, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"

/** agent.registered 返回的一项；Agent 功能决定界面显示哪些控件。 */
export interface RegisteredAgent {
  id: string
  displayName: string
  features: AgentFeatures
}

/** 读取已注册 driver 的 agent。 */
export async function listRegisteredAgents(connection: Connection): Promise<RegisteredAgent[]> {
  return (await connection.call("agent.registered", {})) as RegisteredAgent[]
}

/** 按线程当前的 agent 刷新 Agent 功能；输入框的模型目录由聊天容器按实例懒加载。 */
export async function loadAgentFeatures(
  connection: Connection,
  store: AppStore,
  thread: Thread,
): Promise<void> {
  const agentId = thread.lastAgentId ?? thread.defaultAgentId
  // 切换线程时先清空上一线程的 Agent 功能，避免短暂显示错误的控件。
  store.update({ agentFeatures: null })
  const agents = await listRegisteredAgents(connection)
  const features = agents.find((agent) => agent.id === agentId)?.features
  store.update({ agentFeatures: features ?? null })
}

/**
 * agent 集合或设置变了（插件启停、安装卸载、改了设置）：刷新当前线程的 Agent 功能，
 * 并递增 agentRevision，让输入框重新读取实例列表与模型目录。失败不影响调用方的操作。
 */
export async function refreshAgentViews(deps: {
  connection: Connection
  store: AppStore
}): Promise<void> {
  try {
    const agents = await listRegisteredAgents(deps.connection)
    const snapshot = deps.store.getSnapshot()
    const thread = snapshot.threads.find((item) => item.id === snapshot.activeThreadId)
    if (thread) {
      const agentId = thread.lastAgentId ?? thread.defaultAgentId
      deps.store.update({
        agentFeatures: agents.find((agent) => agent.id === agentId)?.features ?? null,
      })
    }
  } catch {
    // Agent 功能刷新失败时保持原样；revision 仍然递增，让输入框自己重读。
  }
  deps.store.update({ agentRevision: deps.store.getSnapshot().agentRevision + 1 })
}

/** 询问 Host 新会话的默认 agent；没有任何可用的 agent 时为 null。 */
export async function pickAgentId(connection: Connection): Promise<string | null> {
  const result = (await connection.call("agent.default", {})) as {
    id?: unknown
    instanceId?: unknown
  }
  return typeof result.id === "string" && result.id.length > 0 ? result.id : null
}

/** 新会话默认使用的实例；Host 没有给出实例时退回 Agent id（即默认实例）。 */
export async function pickInstanceId(connection: Connection): Promise<string | null> {
  const result = (await connection.call("agent.default", {})) as {
    id?: unknown
    instanceId?: unknown
  }
  if (typeof result.instanceId === "string" && result.instanceId.length > 0)
    return result.instanceId
  return typeof result.id === "string" && result.id.length > 0 ? result.id : null
}

/** 把 agent 的启用状态与检测结果归成一行状态：色调、标题与补充说明。 */
import type { AgentInstance, AgentSummary, AgentStatus } from "@pigcode/contracts"
import type { MessageKey, StatusTone } from "@pigcode/ui-primitives"

/** 状态色调；用 StatusDot 的色调，和侧栏、插件列表里同一种状态同一个颜色。 */
export type AgentTone = Exclude<StatusTone, "running">

/** 一行状态。 */
export interface AgentHeadline {
  tone: AgentTone
  label: MessageKey
  /** 版本、账号或错误原因，没有时为 null。 */
  detail: string | null
}

/**
 * 停用 > 加载失败 > 检测中 > 未安装 > 未登录 > 就绪。
 * 没实现检测的 agent（authenticated 为 null 且没有版本）直接算就绪。
 */
export function agentHeadline(
  agent: Pick<AgentSummary, "enabled" | "registered" | "error">,
  status: AgentStatus | undefined,
): AgentHeadline {
  if (!agent.enabled) return { tone: "idle", label: "agents.status.disabled", detail: null }
  if (!agent.registered) {
    return { tone: "error", label: "agents.status.failed", detail: agent.error }
  }
  if (!status) return { tone: "checking", label: "agents.status.checking", detail: null }
  // 找不到可执行文件的细节（试过的路径、安装方式）放在展开的编辑区里，列表只说结论。
  if (!status.installed) return { tone: "error", label: "agents.status.notInstalled", detail: null }
  const detail = [status.version, status.account].filter(Boolean).join(" · ") || null
  if (status.authenticated === false) {
    return { tone: "warning", label: "agents.status.signedOut", detail }
  }
  return { tone: "ready", label: "agents.status.ready", detail }
}

/**
 * 一个实例的一行状态：实例自己停用时先说停用，其余按它所属 agent 的状态。
 * 列表与详情面板都看这一份，同一个实例在哪里都是同一句话。
 */
export function instanceHeadline(
  agent: Pick<AgentSummary, "enabled" | "registered" | "error">,
  instance: Pick<AgentInstance, "enabled">,
  status: AgentStatus | undefined,
): AgentHeadline {
  if (agent.enabled && !instance.enabled) {
    return { tone: "idle", label: "agents.status.disabled", detail: null }
  }
  return agentHeadline(agent, status)
}

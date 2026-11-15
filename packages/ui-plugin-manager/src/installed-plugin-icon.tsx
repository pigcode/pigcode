/** 已安装插件的图标：内置 Agent 按 manifest 的 driver id 复用品牌，其余使用缩写头像。 */
import { AgentBrandMark, EntityAvatar, agentBrandOf } from "@pigcode/ui-primitives"
import type { PluginSummary } from "./plugin-summary"

export function InstalledPluginIcon({ plugin }: { plugin: PluginSummary }) {
  const agent = plugin.contributes.agent
  const agentId =
    plugin.builtin &&
    plugin.kind === "agent" &&
    agent &&
    typeof agent === "object" &&
    "id" in agent &&
    typeof agent.id === "string"
      ? agent.id
      : null
  const brand = agentBrandOf(agentId)
  if (brand) {
    return (
      <span className="market-icon market-icon-brand" aria-hidden="true">
        <AgentBrandMark brand={brand} />
      </span>
    )
  }
  return (
    <EntityAvatar id={plugin.id} name={plugin.displayName ?? plugin.name} className="market-icon" />
  )
}

import { rm } from "node:fs/promises"
import type { Context } from "cordis"
import type { AgentAuthAction } from "@pigcode/contracts"
import type { AgentDriver } from "./driver"
import type { AgentCatalog } from "./agent-catalog"
import type { AgentsService } from "./service"

/** 实例的登录、停用与清理共享运行门，安装版本则由 Agent 管理。 */
export function createInstanceSetup(
  ctx: Context,
  agents: AgentCatalog,
  drivers: ReadonlyMap<string, AgentDriver>,
  stopRuns: (instanceId: string) => Promise<void>,
  refreshCli: () => Promise<unknown>,
) {
  const stopping = new Set<string>()

  async function withStopped<T>(instanceId: string, action: () => Promise<T>): Promise<T> {
    if (stopping.has(instanceId)) throw new Error("Agent instance is already stopping")
    stopping.add(instanceId)
    try {
      await stopRuns(instanceId)
      return await action()
    } finally {
      stopping.delete(instanceId)
    }
  }

  const auth: AgentsService["auth"] = async (instanceId, request: AgentAuthAction) => {
    const instance = agents.findInstance(instanceId)
    const setup = instance && drivers.get(instance.agentId)?.accountSetup
    const scope = instance && agents.instanceContext(instance)
    if (!instance || !setup || !scope) throw new Error("Agent sign-in is unavailable")
    if (request.action !== "status" && stopping.has(instanceId))
      throw new Error("Agent instance is stopping")
    if (!instance.enabled && request.action === "start")
      throw new Error("Agent instance is disabled")
    const values = await agents.runtimeSettings(instance.agentId, instanceId)
    const perform = () => setup.auth(request, values, scope)
    if (request.action === "logout") return withStopped(instanceId, perform)
    if (request.action !== "start") return perform()
    const status = await setup.auth({ action: "status" }, values, scope)
    if (status.phase === "connected" && !status.usingCliLogin) return status
    return withStopped(instanceId, async () => {
      if (!agents.findInstance(instanceId)?.enabled) throw new Error("Agent instance is disabled")
      return perform()
    })
  }

  const removeCli: AgentsService["removeCli"] = async (instanceId) => {
    const instance = agents.findInstance(instanceId)
    const driver = instance && drivers.get(instance.agentId)
    const scope = instance && agents.instanceContext(instance)
    if (!instance || !driver?.removeManagedCli || !scope)
      throw new Error("Managed CLI removal is unavailable")
    const configured = await Promise.all(
      agents.instances(driver.id).map((item) => agents.runtimeSettings(driver.id, item.instanceId)),
    )
    await driver.removeManagedCli(
      scope,
      configured,
      await agents.runtimeSettings(driver.id, instanceId),
    )
    agents.invalidate()
    await refreshCli()
  }

  const updateInstance: AgentsService["updateInstance"] = (instanceId, patch) => {
    if (stopping.has(instanceId)) throw new Error("Agent instance is stopping")
    const instance = agents.updateInstance(instanceId, patch)
    const scope = agents.instanceContext(instance)
    const setup = drivers.get(instance.agentId)?.accountSetup
    if (patch.enabled !== false || !setup || !scope) return instance
    return withStopped(instanceId, async () => {
      await setup.close(scope)
      return instance
    })
  }

  const removeInstance: AgentsService["removeInstance"] = (instanceId) => {
    const instance = agents.findInstance(instanceId)
    if (!instance) throw new Error(`instance not found: ${instanceId}`)
    if (instance.isDefault) throw new Error(`default instance cannot be removed: ${instanceId}`)
    const usage = ctx.storage.db
      .prepare(
        `SELECT COUNT(*) AS count FROM threads WHERE default_instance_id = ? OR last_instance_id = ?`,
      )
      .get(instanceId, instanceId) as { count: number }
    if (usage.count > 0) {
      throw Object.assign(
        new Error(`instance is in use by ${usage.count} threads: ${instanceId}`),
        {
          code: "AGENT_INSTANCE_IN_USE",
        },
      )
    }
    const scope = agents.instanceContext(instance)
    const driver = drivers.get(instance.agentId)
    const setup = driver?.accountSetup
    if (!scope || (!setup && !driver?.requiresInstance)) {
      agents.removeInstance(instanceId)
      return
    }
    return withStopped(instanceId, async () => {
      await setup?.close(scope)
      await rm(scope.dataDir, { recursive: true, force: true })
      agents.removeInstance(instanceId)
    })
  }

  return {
    auth,
    removeCli,
    updateInstance,
    removeInstance,
    isStopping: (id: string) => stopping.has(id),
  }
}

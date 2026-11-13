/** 插件准备 CLI 更新，Host 统一执行、去重、复检并保存本次运行的进度。 */
import type { AgentCliUpdateState } from "@pigcode/contracts"
import type { AgentCliUpdatePlan, AgentDriver } from "@pigcode/plugin-sdk"
import { cliUpdateAvailable } from "@pigcode/plugin-sdk/node"
import type { AgentCatalog } from "./agent-catalog"
import { setTimeout as delay } from "node:timers/promises"

const OUTPUT_LIMIT = 64 * 1024
const active = (state: AgentCliUpdateState | undefined) =>
  state?.phase === "queued" || state?.phase === "waiting" || state?.phase === "running"

interface UpdateJob {
  state: AgentCliUpdateState
  instances: Set<string>
  controller: AbortController
}

export function createCliUpdates(
  drivers: ReadonlyMap<string, AgentDriver>,
  catalog: AgentCatalog,
  isBusy: (agentId: string) => boolean = () => false,
) {
  const states = new Map<string, AgentCliUpdateState>()
  const jobs = new Map<string, UpdateJob>()
  const preparing = new Map<string, Promise<AgentCliUpdateState>>()
  let queue = Promise.resolve()
  let disposed = false
  const snapshot = (): Record<string, AgentCliUpdateState> =>
    Object.fromEntries(
      [...states].filter(
        ([instanceId, state]) => drivers.has(state.agentId) && catalog.findInstance(instanceId),
      ),
    )

  function empty(instanceId: string, agentId: string): AgentCliUpdateState {
    return {
      instanceId,
      agentId,
      target: instanceId,
      phase: "checking",
      currentVersion: null,
      latestVersion: null,
      available: false,
      canUpdate: false,
      command: null,
      reason: null,
      error: null,
      output: "",
    }
  }

  async function prepare(
    instanceId: string,
  ): Promise<{ state: AgentCliUpdateState; plan: AgentCliUpdatePlan | null }> {
    const instance = catalog.findInstance(instanceId)
    if (!instance) throw new Error(`instance not found: ${instanceId}`)
    const driver = drivers.get(instance.agentId)
    const state = empty(instanceId, instance.agentId)
    if (!driver?.prepareCliUpdate)
      return { state: { ...state, phase: "checked", reason: "unsupported" }, plan: null }
    const plan = await driver.prepareCliUpdate(instance.values)
    return {
      plan,
      state: {
        ...state,
        phase: "checked",
        target: plan.target,
        currentVersion: plan.currentVersion,
        latestVersion: plan.latestVersion,
        command: plan.command,
        reason: plan.reason,
        canUpdate: Boolean(plan.run),
        available: plan.available,
      },
    }
  }

  function publish(job: UpdateJob, patch: Partial<AgentCliUpdateState>) {
    job.state = { ...job.state, ...patch }
    for (const instanceId of job.instances) states.set(instanceId, { ...job.state, instanceId })
  }

  async function checkOne(instanceId: string) {
    if (active(states.get(instanceId)) || preparing.has(instanceId)) return
    const instance = catalog.findInstance(instanceId)
    if (!instance) return
    const initial = empty(instanceId, instance.agentId)
    states.set(instanceId, initial)
    try {
      const { state } = await prepare(instanceId)
      if (active(states.get(instanceId))) return
      const job = jobs.get(state.target)
      if (job) {
        job.instances.add(instanceId)
        publish(job, {})
      } else states.set(instanceId, state)
    } catch (cause) {
      if (!active(states.get(instanceId)))
        states.set(instanceId, {
          ...initial,
          phase: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        })
    }
  }

  async function start(instanceId: string): Promise<AgentCliUpdateState> {
    const current = states.get(instanceId)
    if (active(current)) return current!
    const { state, plan } = await prepare(instanceId)
    const driver = drivers.get(state.agentId)
    if (disposed) throw new Error("Host disposed")
    if (!plan?.run || (plan.latestVersion && !plan.available)) {
      states.set(instanceId, state)
      return state
    }
    const existing = jobs.get(plan.target)
    if (existing) {
      existing.instances.add(instanceId)
      publish(existing, {})
      return states.get(instanceId)!
    }
    const job: UpdateJob = {
      state,
      instances: new Set([instanceId]),
      controller: new AbortController(),
    }
    for (const other of states.values()) {
      if (other.target === plan.target) job.instances.add(other.instanceId)
    }
    jobs.set(plan.target, job)
    publish(job, { phase: "queued", error: null, output: "" })
    queue = queue.then(async () => {
      try {
        job.controller.signal.throwIfAborted()
        while (isBusy(state.agentId)) {
          publish(job, { phase: "waiting" })
          await delay(500, undefined, { signal: job.controller.signal })
        }
        if (drivers.get(state.agentId) !== driver)
          throw new Error("Agent plugin changed. Check for updates again.")
        publish(job, { phase: "running" })
        await plan.run!({
          signal: job.controller.signal,
          onOutput: (text) =>
            publish(job, { output: (job.state.output + text).slice(-OUTPUT_LIMIT) }),
        })
        const version = await plan.verify()
        const unchanged =
          !version ||
          cliUpdateAvailable(version, plan.latestVersion) ||
          (!plan.latestVersion && version === plan.currentVersion)
        publish(job, {
          phase: unchanged ? "unchanged" : "succeeded",
          currentVersion: version ?? plan.currentVersion,
          available: cliUpdateAvailable(version, plan.latestVersion),
        })
      } catch (cause) {
        publish(job, {
          phase: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        catalog.invalidate()
        jobs.delete(plan.target)
      }
    })
    return states.get(instanceId)!
  }

  return {
    isUpdating: (agentId: string) =>
      [...jobs.values()].some(
        (job) => job.state.agentId === agentId && job.state.phase === "running",
      ),
    list: snapshot,
    async check(instanceId?: string): Promise<Record<string, AgentCliUpdateState>> {
      const ids = instanceId
        ? [instanceId]
        : [...drivers.keys()].flatMap((id) =>
            catalog.instances(id).map((instance) => instance.instanceId),
          )
      await Promise.all(ids.map(checkOne))
      return snapshot()
    },
    update(instanceId: string): Promise<AgentCliUpdateState> {
      const pending = preparing.get(instanceId)
      if (pending) return pending
      const operation = start(instanceId).finally(() => preparing.delete(instanceId))
      preparing.set(instanceId, operation)
      return operation
    },
    dispose() {
      disposed = true
      for (const job of jobs.values()) job.controller.abort()
    },
  }
}

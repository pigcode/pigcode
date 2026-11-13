import { describe, expect, it, vi } from "vitest"
import type { AgentCliUpdatePlan, AgentDriver } from "@pigcode/plugin-sdk"
import type { AgentInstance } from "@pigcode/contracts"
import type { AgentCatalog } from "./agent-catalog"
import { createCliUpdates } from "./cli-updates"

function setup(prepare: (id: string) => Promise<AgentCliUpdatePlan>, isBusy = () => false) {
  const instances = ["first", "second", "other"].map((instanceId): AgentInstance => ({
    instanceId,
    agentId: "test",
    label: instanceId,
    enabled: true,
    values: { label: instanceId },
    isDefault: false,
    createdAt: null,
  }))
  const invalidate = vi.fn()
  const catalog = {
    findInstance: (id: string) => instances.find((instance) => instance.instanceId === id) ?? null,
    instances: () => instances,
    invalidate,
  } as unknown as AgentCatalog
  const driver = {
    prepareCliUpdate: (settings: { label: string }) => prepare(settings.label),
  } as unknown as AgentDriver
  const drivers = new Map([["test", driver]])
  return { service: createCliUpdates(drivers, catalog, isBusy), drivers, invalidate }
}

function plan(
  target: string,
  run: AgentCliUpdatePlan["run"],
  verify = async () => "2.0.0",
): AgentCliUpdatePlan {
  return {
    target,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    available: true,
    command: "test-updater",
    reason: null,
    run,
    verify,
  }
}

describe("CLI updates", () => {
  it("removes disabled plugins from the update list", async () => {
    const { service, drivers } = setup(async () => plan("shared", async () => undefined))
    await service.check()
    expect(Object.keys(service.list())).toHaveLength(3)
    drivers.delete("test")
    expect(service.list()).toEqual({})
    service.dispose()
  })
  it("waits for active runs before touching the installation", async () => {
    let busy = true
    const run = vi.fn(async () => undefined)
    const { service } = setup(
      async () => plan("shared", run),
      () => busy,
    )
    await service.update("first")
    await vi.waitFor(() => expect(service.list().first?.phase).toBe("waiting"))
    expect(run).not.toHaveBeenCalled()
    busy = false
    await vi.waitFor(() => expect(service.list().first?.phase).toBe("succeeded"))
    service.dispose()
  })
  it("deduplicates instances sharing an install and serializes separate updates", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const shared = vi.fn(async () => {
      order.push("shared")
      await gate
    })
    const other = vi.fn(async () => {
      order.push("other")
    })
    const { service, invalidate } = setup(async (id) =>
      id === "other" ? plan("other", other) : plan("shared", shared),
    )
    await service.check()
    await Promise.all([service.update("first"), service.update("second"), service.update("other")])
    expect(order).toEqual(["shared"])
    expect(service.list().other?.phase).toBe("queued")
    release()
    await vi.waitFor(() => expect(service.list().other?.phase).toBe("succeeded"))
    expect(shared).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
    expect(service.list().second?.currentVersion).toBe("2.0.0")
    expect(invalidate).toHaveBeenCalledTimes(2)
    service.dispose()
  })
  it("reports unchanged versions after a successful exit and retains failed output for retry", async () => {
    let attempt = 0
    const run = vi.fn(async (runtime) => {
      runtime.onOutput("diagnostic output\n")
      attempt += 1
      if (attempt === 1) throw new Error("permission denied")
    })
    const { service } = setup(async () => plan("shared", run, async () => "1.0.0"))
    await service.update("first")
    await vi.waitFor(() => expect(service.list().first?.phase).toBe("failed"))
    expect(service.list().first?.output).toContain("diagnostic output")
    await service.update("first")
    await vi.waitFor(() => expect(service.list().first?.phase).toBe("unchanged"))
    expect(service.list().first?.available).toBe(true)
    service.dispose()
  })
  it("rejects unsupported updates and skips current releases", async () => {
    const run = vi.fn(async () => undefined)
    const { service } = setup(async () => ({
      ...plan("shared", run),
      currentVersion: "3.0.0",
      latestVersion: "2.0.0",
      available: false,
    }))
    await service.update("first")
    expect(run).not.toHaveBeenCalled()
    expect(service.list().first?.phase).toBe("checked")
    service.dispose()
  })
})

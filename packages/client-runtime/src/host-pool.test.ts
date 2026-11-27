import { describe, expect, it } from "vitest"
import type { HostSummary, Project, Schedule, Thread } from "@pigcode/contracts"
import { Connection } from "./connection"
import { HostPool } from "./host-pool"
import { AppStore } from "./store"

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
  }
}

function makeProject(id: string, name: string): Project {
  return { id, name, rootPath: `/repo/${name}`, createdAt: "2026-11-28T00:00:00.000Z" }
}

function makeThread(id: string, projectId: string, updatedAt: string): Thread {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    defaultAgentId: "claude-code",
    defaultInstanceId: null,
    lastAgentId: "claude-code",
    lastInstanceId: null,
    lastModelId: null,
    permissionMode: "full-access",
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt,
    archivedAt: null,
    lastRunId: null,
  }
}

describe("HostPool", () => {
  it("mixes projects, threads, and schedules across local and remote hosts and preserves offline cache", () => {
    const storage = makeStorage()
    const localStore = new AppStore({ schedule: (fn) => fn() })
    const localConn = new Connection({
      onEvent: () => {},
      onDelta: () => {},
      onStatus: (status) => localStore.update({ status }),
    })
    const pool = new HostPool({
      localConnection: localConn,
      localStore,
      localName: "My Mac Mini",
      storage,
    })

    localStore.update({
      status: "connected",
      projects: [makeProject("p1", "pigcode")],
      threads: [makeThread("t1", "p1", "2026-11-28T01:00:00.000Z")],
    })

    const nasSummary: HostSummary = {
      id: "nas-1",
      name: "home-linux-nas",
      hostKey: "E".repeat(43),
      kind: "headless",
      badgeColor: "green",
      status: "connected",
      channel: "relay",
      latencyMs: 18,
      lanAddresses: [],
      relayAddress: "wss://relay.example/ws/v1/connect",
      lastConnectedAt: 1_700_000_000_000,
      lastError: null,
    }
    pool.syncRemoteHosts([nasSummary])
    const nasSlot = pool.slot("nas-1")
    nasSlot.store.update({
      status: "connected",
      projects: [makeProject("np1", "pigcode")],
      threads: [makeThread("nt1", "np1", "2026-11-28T02:00:00.000Z")],
    })

    const sampleSchedule: Schedule = {
      id: "sch-1",
      title: "Nightly Backup",
      prompt: "run backup",
      draft: null,
      rule: { kind: "daily", time: "03:00" },
      endsAt: null,
      enabled: true,
      target: {
        kind: "project",
        projectId: "np1",
        execution: { instanceId: "claude-code", permissionMode: "full-access" },
      },
      status: "active",
      runCount: 0,
      lastRunAt: null,
      lastRunId: null,
      nextRunAt: "2026-11-29T03:00:00.000Z",
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    }
    pool.setHostSchedules("nas-1", [sampleSchedule])

    expect(pool.listHosts().map((h) => h.id)).toEqual(["local", "nas-1"])
    expect(pool.mixedProjects().map((entry) => `${entry.host.id}:${entry.project.name}`)).toEqual([
      "local:pigcode",
      "nas-1:pigcode",
    ])
    expect(pool.mixedThreads().map((entry) => entry.thread.id)).toEqual(["nt1", "t1"])
    expect(pool.mixedSchedules().map((entry) => `${entry.host.name}:${entry.schedule.id}`)).toEqual(
      ["home-linux-nas:sch-1"],
    )

    // Reconstruct a new HostPool with nas-1 offline -> cached projects, threads, and schedules stay readable!
    const pool2 = new HostPool({
      localConnection: localConn,
      localStore,
      localName: "My Mac Mini",
      storage,
    })
    pool2.syncRemoteHosts([{ ...nasSummary, status: "offline" }])
    expect(
      pool2.mixedProjects().some((p) => p.host.id === "nas-1" && p.project.name === "pigcode"),
    ).toBe(true)
    expect(
      pool2.mixedSchedules().some((s) => s.host.id === "nas-1" && s.schedule.id === "sch-1"),
    ).toBe(true)
    // Offline host falls back to online default ("local") for new targets.
    expect(pool2.resolveTargetHostId("nas-1")).toBe("local")
  })
})

/**
 * Renderer 多主机连接池与聚合状态管理器：
 * 每台主机持有独立的 `Connection` + `AppStore`；远程主机离线时保留最后缓存快照以便界面只读浏览；
 * 并统一输出跨主机的混排项目、会话与定时任务聚合列表。
 */
import {
  HOST_LOCAL_ID,
  scheduleSchema,
  type HostBadgeColor,
  type HostChannel,
  type HostConnectionStatus,
  type HostDefaults,
  type HostKind,
  type HostOutboundPairingStatus,
  type HostSummary,
  type Project,
  type Schedule,
  type Thread,
} from "@pigcode/contracts"
import { Connection, type ConnectionHandlers } from "./connection"
import { AppStore } from "./store"
import type { HostTransport } from "./transport"

export interface HostPoolSnapshotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface HostCachedWorkspace {
  projects: Project[]
  threads: Thread[]
  schedules: Schedule[]
}

export interface HostSlot {
  readonly id: string
  readonly connection: Connection
  readonly store: AppStore
  readonly schedules: readonly Schedule[]
}

export interface MixedProjectEntry {
  host: HostSummary
  project: Project
}

export interface MixedThreadEntry {
  host: HostSummary
  thread: Thread
}

export interface MixedScheduleEntry {
  host: HostSummary
  schedule: Schedule
}

export interface HostPoolSnapshot {
  hosts: readonly HostSummary[]
  defaults: HostDefaults
  pairingState: HostOutboundPairingStatus
  localHostKey: string | null
  localHostName: string
  localBadgeColor: HostBadgeColor
  schedulesByHost: Readonly<Record<string, readonly Schedule[]>>
  revision: number
}

const CACHE_KEY_PREFIX = "pigcode.hostPool.cache."
const LOCAL_COLOR_KEY = "pigcode.hostPool.localColor"
const VALID_COLORS = new Set<HostBadgeColor>(["blue", "green", "amber", "violet", "rose", "slate"])

function readLocalBadgeColor(
  storage: HostPoolSnapshotStorage,
  fallback: HostBadgeColor,
): HostBadgeColor {
  try {
    const raw = storage.getItem(LOCAL_COLOR_KEY) as HostBadgeColor | null
    if (raw && VALID_COLORS.has(raw)) return raw
  } catch {
    // ignore storage failures
  }
  return fallback
}

function readCachedWorkspace(
  storage: HostPoolSnapshotStorage,
  hostId: string,
): HostCachedWorkspace | null {
  try {
    const raw = storage.getItem(`${CACHE_KEY_PREFIX}${hostId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HostCachedWorkspace>
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    }
  } catch {
    return null
  }
}

function writeCachedWorkspace(
  storage: HostPoolSnapshotStorage,
  hostId: string,
  cache: HostCachedWorkspace,
): void {
  try {
    storage.setItem(`${CACHE_KEY_PREFIX}${hostId}`, JSON.stringify(cache))
  } catch {
    // ignore storage quota failures
  }
}

function defaultStorage(): HostPoolSnapshotStorage {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage
  }
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, val) => map.set(key, val),
    removeItem: (key) => map.delete(key),
  }
}

export class HostPool {
  private readonly storage: HostPoolSnapshotStorage
  private readonly slots = new Map<string, { connection: Connection; store: AppStore }>()
  private readonly remoteSummaries = new Map<string, HostSummary>()
  private readonly orderedRemoteIds: string[] = []
  private readonly schedulesByHost = new Map<string, Schedule[]>()
  private readonly listeners = new Set<() => void>()
  private localHostKey: string | null = null
  private localHostName: string
  private localBadgeColor: HostBadgeColor
  private defaults: HostDefaults = { defaultTargetHostId: HOST_LOCAL_ID }
  private pairingState: HostOutboundPairingStatus = {
    state: "idle",
    hostName: null,
    hostKey: null,
    verificationCode: null,
    hostId: null,
    errorCode: null,
  }
  private revision = 0
  private snapshotCache: HostPoolSnapshot | null = null

  constructor(options: {
    localConnection: Connection
    localStore: AppStore
    localName?: string | undefined
    localBadgeColor?: HostBadgeColor | undefined
    storage?: HostPoolSnapshotStorage | undefined
  }) {
    this.storage = options.storage ?? defaultStorage()
    this.localHostName = options.localName ?? "Local Host"
    this.localBadgeColor = options.localBadgeColor ?? readLocalBadgeColor(this.storage, "blue")
    this.slots.set(HOST_LOCAL_ID, {
      connection: options.localConnection,
      store: options.localStore,
    })
    options.localConnection.onScheduleRunChange(() => {
      void this.refreshHostSchedules(HOST_LOCAL_ID)
    })
    options.localStore.subscribe(() => {
      const snap = options.localStore.getSnapshot()
      if (snap.projects.length > 0 || snap.threads.length > 0) {
        this.persistHostCache(HOST_LOCAL_ID, snap.projects, snap.threads)
      }
      this.bump()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): HostPoolSnapshot => {
    if (!this.snapshotCache) {
      const schedulesObj: Record<string, readonly Schedule[]> = {}
      for (const [id, list] of this.schedulesByHost) schedulesObj[id] = list
      this.snapshotCache = {
        hosts: this.listHosts(),
        defaults: this.defaults,
        pairingState: this.pairingState,
        localHostKey: this.localHostKey,
        localHostName: this.localHostName,
        localBadgeColor: this.localBadgeColor,
        schedulesByHost: schedulesObj,
        revision: this.revision,
      }
    }
    return this.snapshotCache
  }

  setLocalIdentity(identity: { hostKey: string; hostName: string }): void {
    this.localHostKey = identity.hostKey
    this.localHostName = identity.hostName
    this.bump()
  }

  setLocalBadgeColor(color: HostBadgeColor): void {
    this.localBadgeColor = color
    try {
      this.storage.setItem(LOCAL_COLOR_KEY, color)
    } catch {
      // ignore storage failures
    }
    this.bump()
  }

  setPairingState(state: HostOutboundPairingStatus): void {
    this.pairingState = state
    this.bump()
  }

  setDefaults(defaults: HostDefaults): void {
    this.defaults = defaults
    this.bump()
  }

  listHosts(): HostSummary[] {
    const localState = this.slots.get(HOST_LOCAL_ID)!.store.getSnapshot()
    const localStatus: HostConnectionStatus =
      localState.status === "connected"
        ? "connected"
        : localState.status === "connecting"
          ? "connecting"
          : "offline"
    const local: HostSummary = {
      id: HOST_LOCAL_ID,
      name: this.localHostName,
      hostKey: this.localHostKey,
      kind: "local" satisfies HostKind,
      badgeColor: this.localBadgeColor,
      status: localStatus,
      channel: "local" satisfies HostChannel,
      latencyMs: localStatus === "connected" ? 0 : null,
      lanAddresses: [],
      relayAddress: null,
      lastConnectedAt: Date.now(),
      lastError: null,
    }
    const remotes = this.orderedRemoteIds
      .map((id) => this.remoteSummaries.get(id))
      .filter((item): item is HostSummary => item !== undefined)
    return [local, ...remotes]
  }

  slot(hostId: string): HostSlot {
    const entry = this.slots.get(hostId) ?? this.slots.get(HOST_LOCAL_ID)!
    const actualId = this.slots.has(hostId) ? hostId : HOST_LOCAL_ID
    return {
      id: actualId,
      connection: entry.connection,
      store: entry.store,
      schedules: this.schedulesByHost.get(actualId) ?? [],
    }
  }

  hasSlot(hostId: string): boolean {
    return this.slots.has(hostId)
  }

  syncRemoteHosts(summaries: readonly HostSummary[], defaults?: HostDefaults): void {
    const nextIds = new Set(summaries.map((item) => item.id))
    for (const oldId of [...this.remoteSummaries.keys()]) {
      if (!nextIds.has(oldId)) {
        this.remoteSummaries.delete(oldId)
        this.schedulesByHost.delete(oldId)
        this.slots.get(oldId)?.connection.detach()
        this.slots.delete(oldId)
        this.storage.removeItem(`${CACHE_KEY_PREFIX}${oldId}`)
      }
    }
    this.orderedRemoteIds.length = 0
    for (const summary of summaries) {
      this.orderedRemoteIds.push(summary.id)
      this.remoteSummaries.set(summary.id, summary)
      this.ensureRemoteSlot(summary.id)
    }
    if (defaults) this.defaults = defaults
    this.bump()
  }

  async attachRemoteTransport(hostId: string, transport: HostTransport): Promise<boolean> {
    const entry = this.ensureRemoteSlot(hostId)
    const connected = await entry.connection.attach(transport)
    if (!connected) return false
    void this.refreshRemoteHostWorkspace(hostId)
    return true
  }

  async refreshHostSchedules(hostId: string): Promise<Schedule[]> {
    const entry = this.slots.get(hostId)
    if (!entry) return []
    const snap = entry.store.getSnapshot()
    if (snap.status !== "connected") return this.schedulesByHost.get(hostId) ?? []
    try {
      const raw = await entry.connection.call("schedule.list", {})
      const schedules = scheduleSchema.array().parse(raw)
      this.schedulesByHost.set(hostId, schedules)
      this.persistHostCache(hostId, snap.projects, snap.threads, schedules)
      this.bump()
      return schedules
    } catch {
      return this.schedulesByHost.get(hostId) ?? []
    }
  }

  setHostSchedules(hostId: string, schedules: readonly Schedule[]): void {
    const copy = [...schedules]
    this.schedulesByHost.set(hostId, copy)
    const entry = this.slots.get(hostId)
    if (entry) {
      const snap = entry.store.getSnapshot()
      this.persistHostCache(hostId, snap.projects, snap.threads, copy)
    }
    this.bump()
  }

  mixedProjects(): MixedProjectEntry[] {
    const out: MixedProjectEntry[] = []
    for (const host of this.listHosts()) {
      const slot = this.slots.get(host.id)
      if (!slot) continue
      for (const project of slot.store.getSnapshot().projects) {
        out.push({ host, project })
      }
    }
    return out
  }

  mixedThreads(): MixedThreadEntry[] {
    const out: MixedThreadEntry[] = []
    for (const host of this.listHosts()) {
      const slot = this.slots.get(host.id)
      if (!slot) continue
      for (const thread of slot.store.getSnapshot().threads) {
        if (!thread.parentThreadId) out.push({ host, thread })
      }
    }
    out.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt))
    return out
  }

  mixedSchedules(): MixedScheduleEntry[] {
    const out: MixedScheduleEntry[] = []
    for (const host of this.listHosts()) {
      const list = this.schedulesByHost.get(host.id) ?? []
      for (const schedule of list) out.push({ host, schedule })
    }
    return out
  }

  resolveTargetHostId(preferredHostId?: string | null): string {
    const hosts = this.listHosts()
    if (preferredHostId) {
      const candidate = hosts.find((h) => h.id === preferredHostId)
      if (candidate?.status === "connected") return candidate.id
    }
    const defaultHost = hosts.find((h) => h.id === this.defaults.defaultTargetHostId)
    if (defaultHost?.status === "connected") return defaultHost.id
    return HOST_LOCAL_ID
  }

  private async refreshRemoteHostWorkspace(hostId: string): Promise<void> {
    const entry = this.slots.get(hostId)
    if (!entry) return
    try {
      const [projects, threads, schedulesRaw] = await Promise.all([
        entry.connection.call("project.list", {}) as Promise<Project[]>,
        entry.connection.call("thread.list", {}) as Promise<Thread[]>,
        entry.connection.call("schedule.list", {}),
      ])
      const schedules = scheduleSchema.array().parse(schedulesRaw)
      entry.store.update({ projects, threads })
      this.schedulesByHost.set(hostId, schedules)
      this.persistHostCache(hostId, projects, threads, schedules)
      this.bump()
    } catch {
      // ignore transient disconnect during background sync
    }
  }

  private ensureRemoteSlot(hostId: string): { connection: Connection; store: AppStore } {
    const existing = this.slots.get(hostId)
    if (existing) return existing

    const store = new AppStore()
    const cached = readCachedWorkspace(this.storage, hostId)
    if (cached) {
      store.update({ projects: cached.projects, threads: cached.threads })
      this.schedulesByHost.set(hostId, cached.schedules)
    }

    const handlers: ConnectionHandlers = {
      onEvent: (event) => store.addEvent(event),
      onEvents: (events, threadId) => store.addEvents(events, threadId),
      onDelta: (delta) => {
        if (delta.event.type === "message.delta") {
          store.queueDelta(delta.threadId, delta.event.text)
        } else if (delta.event.type === "tool.outputDelta") {
          store.queueToolOutput(delta.threadId, delta.event.toolCallId, delta.event.delta)
        } else if (delta.event.type === "reasoning.delta") {
          store.queueReasoning(delta.threadId, delta.event.text)
        }
      },
      onStatus: (status) => {
        store.update(
          status === "connected"
            ? { status, connectionRevision: connection.connectionRevision }
            : { status },
        )
        const currentSummary = this.remoteSummaries.get(hostId)
        if (currentSummary) {
          const nextStatus: HostConnectionStatus =
            status === "connected"
              ? "connected"
              : status === "connecting"
                ? "connecting"
                : currentSummary.status === "revoked" || currentSummary.status === "auth-failed"
                  ? currentSummary.status
                  : "offline"
          this.remoteSummaries.set(hostId, { ...currentSummary, status: nextStatus })
        }
        this.bump()
      },
      onLiveSnapshot: (threadId, live) => store.restoreLiveRun(threadId, live),
      onScheduledThread: (thread) => {
        const { threads } = store.getSnapshot()
        if (!threads.some((item) => item.id === thread.id)) {
          store.update({ threads: [thread, ...threads] })
        }
      },
      onThreadChanged: (thread) => store.upsertThread(thread),
      onProjectsChanged: (projects) => {
        store.update({ projects })
        this.persistHostCache(hostId, projects, store.getSnapshot().threads)
      },
    }
    const connection = new Connection(handlers)
    connection.onScheduleRunChange(() => {
      void this.refreshHostSchedules(hostId)
    })

    store.subscribe(() => {
      const snap = store.getSnapshot()
      this.persistHostCache(hostId, snap.projects, snap.threads)
      this.bump()
    })

    const entry = { connection, store }
    this.slots.set(hostId, entry)
    return entry
  }

  private persistHostCache(
    hostId: string,
    projects: Project[],
    threads: Thread[],
    schedules: Schedule[] = this.schedulesByHost.get(hostId) ?? [],
  ): void {
    writeCachedWorkspace(this.storage, hostId, { projects, threads, schedules })
  }

  private bump(): void {
    this.revision += 1
    this.snapshotCache = null
    for (const listener of [...this.listeners]) listener()
  }
}

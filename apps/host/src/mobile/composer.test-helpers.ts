import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import type { AgentDriver, CreateSessionInput, UserInput } from "../agents/driver"
import { FakeAgentDriver, FAKE_MODELS } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

export interface RecordingDriverOptions {
  id: string
  displayName?: string
  plan?: boolean
  permissions?: Array<"approval-required" | "auto-accept-edits" | "auto" | "full-access">
  holdGate?: Promise<void>
  models?: typeof FAKE_MODELS
}

export function createRecordingDriver(options: RecordingDriverOptions) {
  const created: CreateSessionInput[] = []
  const inputs: UserInput[] = []
  const fixture = new FakeAgentDriver()
  const driver: AgentDriver = {
    id: options.id,
    displayName: options.displayName ?? options.id,
    features: fixture.features,
    executionModes: {
      plan: options.plan ?? true,
      ...(options.permissions ? { permissions: options.permissions } : {}),
    },
    detect: () => fixture.detect(),
    listModels: async () => options.models ?? FAKE_MODELS,
    async createSession(input) {
      created.push(input)
      return {
        id: input.sessionId ?? `ps_${options.id}_${created.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "full-access",
        planMode: input.planMode ?? false,
        model: input.model ?? null,
      }
    },
    async send(_session, input, runtime) {
      inputs.push(input)
      if (input.text === "hold" && options.holdGate) {
        runtime.emit({ type: "message.delta", text: "holding" })
        await options.holdGate
      }
      runtime.emit({ type: "message.completed", text: `reply:${input.text}` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, created, inputs }
}

export async function setupComposerHarness(
  features: readonly string[],
  extraDrivers: AgentDriver[] = [],
) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  for (const driver of extraDrivers) ctx.agents.register(driver)

  const feed = new ThreadFeed(ctx)
  const desktopWire = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const desktopServer = new RpcServer(ctx, desktopWire.host, feed)
  const desktopNotifications: unknown[] = []
  desktopWire.client.onMessage((message) => {
    const record = message as { method?: string }
    if (record.method) desktopNotifications.push(message)
  })
  desktopServer.start()

  const deviceKey = Buffer.alloc(32, 11).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: 1000 })

  const mobileWire = new MemoryTransport()
  const mobileNotifications: unknown[] = []
  const mobileReplies = new Map<string, (message: unknown) => void>()
  mobileWire.client.onMessage((message) => {
    const record = message as { id?: string; method?: string }
    if (record.id && mobileReplies.has(record.id)) {
      const resolve = mobileReplies.get(record.id)!
      mobileReplies.delete(record.id)
      resolve(message)
    } else if (record.method) {
      mobileNotifications.push(message)
    }
  })

  const mobile = new MobileSidebarRpc(ctx, feed, mobileWire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features,
    relayRevision: () => undefined,
  })
  mobile.start()

  async function mobileCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    const reply = new Promise<unknown>((resolve) => mobileReplies.set(id, resolve))
    mobileWire.client.send({ jsonrpc: "2.0", id, method, params })
    return (await reply) as { id: string; result?: unknown; error?: { code: string } }
  }

  async function desktopCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    desktopWire.client.send({ jsonrpc: "2.0", id, method, params })
    for (;;) {
      const message = (await desktopWire.client.next()) as {
        id?: string
        result?: unknown
        error?: { code: string; message: string }
      }
      if (message.id === id) return message
    }
  }

  return {
    ctx,
    feed,
    devices,
    deviceKey,
    mobileNotifications,
    desktopNotifications,
    mobileCall,
    desktopCall,
    async dispose() {
      mobile.stop()
      desktopServer.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

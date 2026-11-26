import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import type { AgentCommandInfo, AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

export interface MentionsSetupOptions {
  features: readonly string[]
  extraDrivers?: AgentDriver[]
  withWorkspace?: boolean
}

export async function setupMentionsHarness({
  features,
  extraDrivers = [],
  withWorkspace = true,
}: MentionsSetupOptions) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  if (withWorkspace) await ctx.plugin(workspace)
  await ctx.plugin(agents)
  for (const driver of extraDrivers) ctx.agents.register(driver)

  const feed = new ThreadFeed(ctx)
  const deviceKey = Buffer.alloc(32, 23).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({
    publicKey: deviceKey,
    name: "联想测试手机",
    platform: "ios",
    lastConnectedAt: 1000,
  })

  const wire = new MemoryTransport()
  const replies = new Map<string, (message: unknown) => void>()
  wire.client.onMessage((message) => {
    const record = message as { id?: string }
    if (record.id && replies.has(record.id)) {
      const resolve = replies.get(record.id)!
      replies.delete(record.id)
      resolve(message)
    }
  })

  const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features,
    relayRevision: () => undefined,
  })
  mobile.start()

  async function mobileCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    const reply = new Promise<unknown>((resolve) => replies.set(id, resolve))
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    return (await reply) as {
      id: string
      result?: unknown
      error?: { code: string; message: string }
    }
  }

  return {
    ctx,
    devices,
    deviceKey,
    mobileCall,
    async dispose() {
      mobile.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

export function createCommandDriver(
  id: string,
  listCommands: (cwd: string | null) => Promise<AgentCommandInfo[]>,
): AgentDriver {
  const fixture = new FakeAgentDriver()
  return {
    id,
    displayName: `Driver ${id}`,
    features: fixture.features,
    executionModes: { plan: true },
    detect: () => fixture.detect(),
    listModels: () => fixture.listModels(),
    listCommands: (_settings, cwd) => listCommands(cwd),
    createSession: (input) => fixture.createSession(input),
    send: (session, input, runtime) => fixture.send(session, input, runtime),
    interrupt: () => fixture.interrupt(),
    dispose: () => fixture.dispose(),
  }
}

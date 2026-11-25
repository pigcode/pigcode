import { randomUUID } from "node:crypto"
import { rpcNotificationSchema } from "@pigcode/contracts"
import { Context } from "cordis"
import { expect } from "vitest"
import type { AgentRunConfig } from "../agents/driver"
import { apply as agents } from "../agents/registry"
import { MobileConnections } from "../mobile/connections"
import { apply as attachments } from "../services/attachments"
import { apply as projects } from "../services/projects"
import { RelaySettings } from "../services/relay-settings"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"
import { ThreadFeed } from "./thread-feed"

export const mobileTestCipher = {
  seal: async (value: string) =>
    Buffer.from(JSON.stringify([randomUUID(), value])).toString("base64"),
  open: async (value: string) =>
    (JSON.parse(Buffer.from(value, "base64").toString()) as [string, string])[1],
}

export async function startMobileHost(options?: {
  settingsPath?: string
  storagePath?: string
  agentConfig?: AgentRunConfig
  now?: () => number
  prepare?: (ctx: Context) => void
  onDesktopMessage?: (message: unknown) => void
}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: options?.storagePath ?? ":memory:" })
  await ctx.plugin(attachments)
  await ctx.plugin(settings, options?.settingsPath ? { path: options.settingsPath } : {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents, options?.agentConfig ?? {})
  options?.prepare?.(ctx)
  const cipher = mobileTestCipher
  const relay = new RelaySettings(ctx.settings, cipher)
  const feed = new ThreadFeed(ctx)
  const mobile = new MobileConnections(ctx, relay, cipher, feed, options?.now)
  ctx.provide("relaySettings", relay)
  ctx.provide("mobileConnections", mobile)

  const transport = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const server = new RpcServer(ctx, transport.host, feed)
  if (options?.onDesktopMessage) transport.client.onMessage(options.onDesktopMessage)
  server.start()

  return {
    ctx,
    async call(method: string, params: Record<string, unknown> = {}) {
      const id = randomUUID()
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      let response: unknown
      do {
        response = await transport.client.next()
      } while (rpcNotificationSchema.safeParse(response).success)
      expect(response).toMatchObject({ jsonrpc: "2.0", id })
      return response
    },
    async stop() {
      server.stop()
      mobile.dispose()
      await ctx.fiber.dispose()
    },
  }
}

import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { expect } from "vitest"
import { apply as agents } from "../agents/registry"
import { MobileConnections } from "../mobile/connections"
import { apply as projects } from "../services/projects"
import { RelaySettings } from "../services/relay-settings"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

export async function startMobileHost(options?: { settingsPath?: string; now?: () => number }) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, options?.settingsPath ? { path: options.settingsPath } : {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  const cipher = {
    seal: async (value: string) =>
      Buffer.from(JSON.stringify([randomUUID(), value])).toString("base64"),
    open: async (value: string) =>
      (JSON.parse(Buffer.from(value, "base64").toString()) as [string, string])[1],
  }
  const relay = new RelaySettings(ctx.settings, cipher)
  const mobile = new MobileConnections(ctx.settings, relay, cipher, options?.now)
  ctx.provide("relaySettings", relay)
  ctx.provide("mobileConnections", mobile)

  const transport = new MemoryTransport({ skip: ["thread.changed"] })
  const server = new RpcServer(ctx, transport.host)
  server.start()

  return {
    async call(method: string, params: Record<string, unknown> = {}) {
      const id = randomUUID()
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      const response = await transport.client.next()
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

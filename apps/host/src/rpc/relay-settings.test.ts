import { Context } from "cordis"
import { expect, it, vi } from "vitest"
import { apply as agents } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { RelaySettings } from "../services/relay-settings"
import type { RelayProbe } from "../services/relay-probe"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

async function startHost(probe?: RelayProbe) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  ctx.provide(
    "relaySettings",
    new RelaySettings(
      ctx.settings,
      {
        seal: async (value) => Buffer.from(value).toString("base64"),
        open: async (value) => Buffer.from(value, "base64").toString(),
      },
      probe,
    ),
  )
  const transport = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const server = new RpcServer(ctx, transport.host)
  server.start()
  let nextId = 0
  return {
    async call(method: string, params: unknown) {
      const id = String(++nextId)
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      const response = await transport.client.next()
      expect(response).toMatchObject({ jsonrpc: "2.0", id })
      return response
    },
    async stop() {
      server.stop()
      await ctx.fiber.dispose()
    },
  }
}

it("tests and saves the relay through desktop RPC without returning the access token", async () => {
  const probe = vi.fn<RelayProbe>().mockResolvedValue("ok")
  const host = await startHost(probe)
  try {
    const address = "wss://relay.example/ws/v1/connect"
    const token = "example-relay-token"
    expect(await host.call("relay.settings", {})).toMatchObject({
      result: { address: null, tokenConfigured: false },
    })
    expect(await host.call("relay.testAndSave", { address, token })).toMatchObject({
      result: { status: "saved", settings: { address, tokenConfigured: true } },
    })
    expect(probe).toHaveBeenCalledWith(address, token)
    const configured = await host.call("relay.settings", {})
    expect(configured).toMatchObject({ result: { address, tokenConfigured: true } })
    expect(JSON.stringify(configured)).not.toContain(token)
  } finally {
    await host.stop()
  }
})

it("keeps the previous relay configuration when a new address or token fails", async () => {
  const probe = vi
    .fn<RelayProbe>()
    .mockResolvedValueOnce("ok")
    .mockResolvedValueOnce("token-rejected")
    .mockResolvedValueOnce("unreachable")
  const host = await startHost(probe)
  try {
    const address = "wss://relay.example/ws/v1/connect"
    expect(await host.call("relay.testAndSave", { address, token: "first-token" })).toMatchObject({
      result: { status: "saved" },
    })
    expect(
      await host.call("relay.testAndSave", { address: "ws://relay.example", token: "first-token" }),
    ).toMatchObject({
      result: { status: "invalid-address" },
    })
    expect(await host.call("relay.testAndSave", { address, token: "wrong-token" })).toMatchObject({
      result: { status: "token-rejected" },
    })
    expect(
      await host.call("relay.testAndSave", { address: "wss://other.example", token: "new-token" }),
    ).toMatchObject({
      result: { status: "unreachable" },
    })
    expect(probe).toHaveBeenLastCalledWith("wss://other.example/ws/v1/connect", "new-token")
    expect(await host.call("relay.settings", {})).toMatchObject({
      result: { address, tokenConfigured: true },
    })
  } finally {
    await host.stop()
  }
})

const liveAddress = process.env.PIGCODE_RELAY_TEST_URL
const liveToken = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!liveAddress || !liveToken)(
  "tests and saves settings against the real Go relay over WSS",
  async () => {
    const host = await startHost()
    try {
      const accepted = await host.call("relay.testAndSave", {
        address: liveAddress,
        token: liveToken,
      })
      expect(accepted).toMatchObject({ result: { status: "saved" } })
      const refused = await host.call("relay.testAndSave", {
        address: liveAddress,
        token: "pigcode-wss-check-wrong-token",
      })
      expect(refused).toMatchObject({ result: { status: "token-rejected" } })
      expect(await host.call("relay.settings", {})).toMatchObject({
        result: { tokenConfigured: true },
      })
    } finally {
      await host.stop()
    }
  },
)

it("requires a newly entered token when the relay address changes", async () => {
  const probe = vi.fn<RelayProbe>().mockResolvedValue("ok")
  const host = await startHost(probe)
  try {
    expect(
      await host.call("relay.testAndSave", { address: "wss://one.example", token: "first-token" }),
    ).toMatchObject({
      result: { status: "saved" },
    })
    expect(await host.call("relay.testAndSave", { address: "wss://two.example" })).toMatchObject({
      result: { status: "token-required" },
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(await host.call("relay.settings", {})).toMatchObject({
      result: { address: "wss://one.example/ws/v1/connect", tokenConfigured: true },
    })
  } finally {
    await host.stop()
  }
})

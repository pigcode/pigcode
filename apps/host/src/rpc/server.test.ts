import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

async function createServer() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  const transport = new MemoryTransport()
  const server = new RpcServer(ctx, transport.host)
  server.start()
  return { ctx, transport, server }
}

describe("rpc server", () => {
  it("answers project.list", async () => {
    const { ctx, transport } = await createServer()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "project.list", params: {} })
    const response = await transport.client.next()
    expect(response).toMatchObject({ jsonrpc: "2.0", id: "1", result: [] })
    await ctx.fiber.dispose()
  })
})

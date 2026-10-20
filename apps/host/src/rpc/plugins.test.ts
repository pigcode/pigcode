/** 验证通过 RPC 读取插件列表。 */
import { Context } from "cordis"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { apply as pluginsPlugin } from "../services/plugins"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

describe("plugin rpc", () => {
  it("lists plugins", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-rpc-plugins-"))
    const ctx = new Context()
    await ctx.plugin(pluginsPlugin, { profileDir })
    const transport = new MemoryTransport()
    new RpcServer(ctx, transport.host).start()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "plugin.list", params: {} })
    const response = (await transport.client.next()) as { result: unknown[] }
    expect(response.result).toEqual([])
    await ctx.fiber.dispose()
  })
})

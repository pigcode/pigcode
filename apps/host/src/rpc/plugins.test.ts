/** 验证通过 RPC 读取插件列表。 */
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { apply as pluginsPlugin } from "../services/plugins"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

describe("plugin rpc", () => {
  it("lists plugins", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-rpc-plugins-"))
    const ctx = new Context()
    const base = pathToFileURL(profileDir).href
    await ctx.plugin(Loader, { baseUrl: base.endsWith("/") ? base : `${base}/` })
    await ctx.plugin(pluginsPlugin, { profileDir })
    const transport = new MemoryTransport()
    new RpcServer(ctx, transport.host).start()
    transport.client.send({ jsonrpc: "2.0", id: "1", method: "plugin.list", params: {} })
    const response = (await transport.client.next()) as { result: unknown[] }
    expect(response.result).toEqual([])
    await ctx.fiber.dispose()
  })

  it("pushes plugin.changed for external mutations without echoing desktop RPCs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-rpc-plugins-notify-"))
    const profileDir = join(root, "profile")
    const builtinDir = join(root, "builtin-demo")
    await mkdir(profileDir, { recursive: true })
    await mkdir(builtinDir, { recursive: true })
    await writeFile(
      join(builtinDir, "package.json"),
      JSON.stringify({
        name: "@pigcode/demo-builtin",
        version: "0.1.0",
        pigcode: { apiVersion: 1, kind: "capability", displayName: "Demo" },
      }),
    )
    const ctx = new Context()
    const base = pathToFileURL(profileDir).href
    await ctx.plugin(Loader, { baseUrl: base.endsWith("/") ? base : `${base}/` })
    await ctx.plugin(pluginsPlugin, { profileDir, builtin: [builtinDir] })
    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    const [demo] = await ctx.plugins.list()
    expect(demo).toBeDefined()

    // 外部变更（例如手机端）必须实时推送 plugin.changed 给桌面端。
    await ctx.plugins.disable(demo!.id)
    expect(await transport.client.next()).toEqual({
      jsonrpc: "2.0",
      method: "plugin.changed",
      params: {},
    })

    // 桌面端自己通过 RPC 发起的变更直接返回结果，不再重复回声推送 plugin.changed。
    transport.client.send({
      jsonrpc: "2.0",
      id: "2",
      method: "plugin.enable",
      params: { id: demo!.id },
    })
    const reply = (await transport.client.next()) as { id: string; error?: unknown }
    expect(reply.id).toBe("2")
    expect(reply.error).toBeUndefined()

    transport.client.send({ jsonrpc: "2.0", id: "3", method: "plugin.list", params: {} })
    const listed = (await transport.client.next()) as { id: string; result: unknown[] }
    expect(listed.id).toBe("3")
    expect(listed.result).toHaveLength(1)

    server.stop()
    await ctx.fiber.dispose()
  })
})

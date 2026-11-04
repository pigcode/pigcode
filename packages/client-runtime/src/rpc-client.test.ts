import { describe, expect, it } from "vitest"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { CONNECTION_CLOSED, RpcCallError, RpcClient } from "./rpc-client"
import type { HostTransport } from "./transport"

describe("rpc client", () => {
  it("resolves a call by id", async () => {
    const transport = new MemoryTransport()
    const client = new RpcClient(transport.client)
    const pending = client.call("project.list", {})
    transport.host.send({ jsonrpc: "2.0", id: "1", result: { ok: true } })
    const result = await pending
    expect(result).toEqual({ ok: true })
  })

  it("rejects with the error code the Host sent", async () => {
    const transport = new MemoryTransport()
    const client = new RpcClient(transport.client)
    const pending = client.call("pr.status", { threadId: "t1" })
    transport.host.send({
      jsonrpc: "2.0",
      id: "1",
      error: { code: "GIT_NO_REMOTE", message: "no git remotes found" },
    })
    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RpcCallError)
    expect(failure).toMatchObject({ code: "GIT_NO_REMOTE", message: "no git remotes found" })
  })

  it("rejects in-flight calls when the connection is closed", async () => {
    const transport = new MemoryTransport()
    const client = new RpcClient(transport.client)
    const first = client.call("workspace.readFile", { path: "README.md" })
    const second = client.call("project.list", {})

    client.close()

    // 两个调用都要结束；Host 重启时等它们的界面（例如文件标签）不能一直停在加载中。
    await expect(first).rejects.toMatchObject({
      code: CONNECTION_CLOSED,
      message: "host connection lost",
    })
    await expect(second).rejects.toBeInstanceOf(RpcCallError)
  })

  it("refuses new calls after close and accepts closing twice", async () => {
    const transport = new MemoryTransport()
    const client = new RpcClient(transport.client)
    client.close()
    client.close()

    await expect(client.call("project.list", {})).rejects.toMatchObject({
      code: CONNECTION_CLOSED,
    })
  })

  it("ignores late messages after close even when the transport keeps delivering", () => {
    // MemoryTransport.close 会清掉监听器；这里用不清理、记录 close 次数的传输层，
    // 确认客户端自己也拦住了迟到消息，并且关掉了传输层。
    let deliver: ((message: unknown) => void) | undefined
    let closes = 0
    const transport: HostTransport = {
      send: () => {},
      onMessage: (listener) => {
        deliver = listener
        return () => {}
      },
      close: () => {
        closes += 1
      },
    }
    const client = new RpcClient(transport)
    const seen: unknown[] = []
    client.onNotification((message) => seen.push(message))

    client.close()
    client.close()
    // close 之后才注册的监听器只能靠 closed 守卫拦住；清空监听器拦不住它。
    client.onNotification((message) => seen.push(message))
    deliver?.({ jsonrpc: "2.0", method: "thread.event", params: { threadId: "th_1" } })

    expect(seen).toEqual([])
    expect(closes).toBe(1)
  })
})

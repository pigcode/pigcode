/** 验证请求/响应关联、通知分发与 server request 应答。 */
import { describe, expect, it, vi } from "vitest"
import { CodexRpcClient } from "./client"
import { ReplayCodexTransport } from "./transport"

describe("CodexRpcClient", () => {
  it("resolves a request by id", async () => {
    const transport = new ReplayCodexTransport([])
    const client = new CodexRpcClient(transport)
    const pending = client.request("initialize", {
      clientInfo: { name: "pigcode", version: "0.1.0" },
    })
    const sent = JSON.parse(transport.sent[0]!)
    transport.push({ id: sent.id, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it("rejects a request when the server returns an error", async () => {
    const transport = new ReplayCodexTransport([])
    const client = new CodexRpcClient(transport)
    const pending = client.request("thread/start", {})
    const sent = JSON.parse(transport.sent[0]!)
    transport.push({ id: sent.id, error: { code: -32600, message: "bad request" } })
    await expect(pending).rejects.toThrow(/bad request/)
  })

  it("dispatches notifications to every subscribed handler", () => {
    const transport = new ReplayCodexTransport([])
    const client = new CodexRpcClient(transport)
    const received: unknown[] = []
    const first = (params: unknown): void => {
      received.push(params)
    }
    const second = (params: unknown): void => {
      received.push(params)
    }
    const dispose = client.onNotification("turn/started", first)
    client.onNotification("turn/started", second)
    transport.push({ method: "turn/started", params: { turnId: "t1" } })
    expect(received).toEqual([{ turnId: "t1" }, { turnId: "t1" }])
    dispose()
    transport.push({ method: "turn/started", params: { turnId: "t2" } })
    expect(received).toEqual([{ turnId: "t1" }, { turnId: "t1" }, { turnId: "t2" }])
  })

  it("answers a server request", async () => {
    const transport = new ReplayCodexTransport([])
    const client = new CodexRpcClient(transport)
    const handler = vi.fn(async () => ({ decision: "accept" }))
    client.onServerRequest("item/commandExecution/requestApproval", handler)
    transport.push({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "i1" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handler).toHaveBeenCalledOnce()
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({ id: 7, result: { decision: "accept" } })
  })

  it("answers an unsupported server request with method-not-found", () => {
    const transport = new ReplayCodexTransport([])
    new CodexRpcClient(transport)
    transport.push({ id: 9, method: "unknown/method", params: {} })
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({ id: 9, error: { code: -32601 } })
  })
})

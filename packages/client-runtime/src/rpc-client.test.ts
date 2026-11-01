import { describe, expect, it } from "vitest"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { RpcCallError, RpcClient } from "./rpc-client"

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
})

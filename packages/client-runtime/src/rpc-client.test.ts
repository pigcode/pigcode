import { describe, expect, it } from "vitest"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { RpcClient } from "./rpc-client"

describe("rpc client", () => {
  it("resolves a call by id", async () => {
    const transport = new MemoryTransport()
    const client = new RpcClient(transport.client)
    const pending = client.call("project.list", {})
    transport.host.send({ jsonrpc: "2.0", id: "1", result: { ok: true } })
    const result = await pending
    expect(result).toEqual({ ok: true })
  })
})

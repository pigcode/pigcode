/** 验证版本化 RPC 信封的解析与稳定错误码。 */
import { describe, expect, it } from "vitest"

import { PROTOCOL_VERSION, parseRpcRequest, rpcFailureSchema } from "./protocol"

describe("protocol", () => {
  it("parses a valid request", () => {
    const request = parseRpcRequest({
      jsonrpc: "2.0",
      id: "req-1",
      method: "project.list",
      params: {},
    })
    expect(request.method).toBe("project.list")
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it("rejects a malformed envelope", () => {
    expect(() => parseRpcRequest({ jsonrpc: "1.0", id: "x", method: "a" })).toThrow()
  })

  it("keeps stable error codes", () => {
    const failure = rpcFailureSchema.parse({
      jsonrpc: "2.0",
      id: "req-1",
      error: { code: "PROVIDER_NOT_INSTALLED", message: "missing", retryable: false },
    })
    expect(failure.error.code).toBe("PROVIDER_NOT_INSTALLED")
  })
})

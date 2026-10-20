/** 验证 NDJSON 信封分类。 */
import { describe, expect, it } from "vitest"
import { classifyCodexMessage } from "./protocol"

describe("classifyCodexMessage", () => {
  it("classifies a response", () => {
    expect(classifyCodexMessage({ id: 1, result: {} })).toBe("response")
  })
  it("classifies a notification", () => {
    expect(classifyCodexMessage({ method: "turn/started", params: {} })).toBe("notification")
  })
  it("classifies a server request", () => {
    expect(
      classifyCodexMessage({ id: 2, method: "item/commandExecution/requestApproval", params: {} }),
    ).toBe("request")
  })
})

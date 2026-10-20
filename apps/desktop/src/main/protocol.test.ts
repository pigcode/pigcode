/** 验证 pigcode:// 协议只解析根目录内的路径。 */
import { describe, expect, it } from "vitest"
import { resolveInside } from "./protocol"

describe("protocol path resolution", () => {
  it("resolves a file inside the root", () => {
    expect(resolveInside("/tmp/root", "client.js")).toBe("/tmp/root/client.js")
  })

  it("rejects a traversal path", () => {
    expect(() => resolveInside("/tmp/root", "../secret")).toThrow()
  })
})

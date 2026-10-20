/** 验证 manifest 结构与 apiVersion/engines 兼容性。 */
import { describe, expect, it } from "vitest"
import { checkPluginCompatibility, pluginManifestSchema } from "./manifest"

const base = {
  name: "@pigcode/provider-fake",
  version: "0.0.0",
  pigcode: {
    apiVersion: 1,
    kind: "provider",
    host: "./index.mjs",
    inject: ["providers"],
    provides: ["provider:fake"],
    contributes: {},
    permissions: ["process:spawn"],
  },
}

describe("plugin manifest", () => {
  it("accepts a valid manifest", () => {
    const manifest = pluginManifestSchema.parse(base)
    expect(manifest.pigcode.kind).toBe("provider")
  })

  it("rejects a plugin without host or client entry", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        pigcode: { ...base.pigcode, host: undefined },
      }),
    ).toThrow()
  })

  it("rejects an incompatible api version", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        pigcode: { ...base.pigcode, apiVersion: 2 },
      }),
    ).toThrow()
  })
})

describe("plugin compatibility", () => {
  const compatibleBase = {
    name: "demo",
    version: "1.0.0",
    engines: { pigcode: ">=0.1.0" },
    pigcode: { apiVersion: 1 as const, kind: "ui" as const, client: "./client.js" },
  }

  it("accepts the current API and engine range", () => {
    expect(checkPluginCompatibility(pluginManifestSchema.parse(compatibleBase))).toBeNull()
  })

  it("rejects an unsupported engine range", () => {
    const manifest = pluginManifestSchema.parse({
      ...compatibleBase,
      engines: { pigcode: ">=99.0.0" },
    })
    expect(checkPluginCompatibility(manifest)).toContain("engines")
  })
})

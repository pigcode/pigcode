import { describe, expect, it } from "vitest"
import { pluginManifestSchema } from "./manifest"

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

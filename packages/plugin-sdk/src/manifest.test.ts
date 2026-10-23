/** 验证 manifest 结构与 apiVersion/engines 兼容性。 */
import { describe, expect, it } from "vitest"
import {
  checkPluginCompatibility,
  pluginManifestSchema,
  readProviderContribution,
} from "./manifest"

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

  it("reads the provider contribution with its settings fields", () => {
    const manifest = pluginManifestSchema.parse({
      ...base,
      pigcode: {
        ...base.pigcode,
        contributes: {
          provider: {
            id: "fake",
            description: { "zh-CN": "测试用", "en-US": "For tests" },
            settings: [
              { key: "binaryPath", type: "path", label: "Binary path", placeholder: "fake" },
              { key: "environment", type: "env", label: "Environment" },
            ],
          },
        },
      },
    })
    const provider = readProviderContribution(manifest)
    expect(provider?.id).toBe("fake")
    expect(provider?.customModels).toBe(true)
    expect(provider?.settings.map((field) => field.key)).toEqual(["binaryPath", "environment"])
    expect(provider?.settings[0]).toMatchObject({ type: "path", pathKind: "file" })
  })

  it("infers a bare provider contribution from provides", () => {
    const provider = readProviderContribution(pluginManifestSchema.parse(base))
    expect(provider).toMatchObject({ id: "fake", settings: [], customModels: true })
  })

  it("rejects duplicate or reserved setting keys", () => {
    const withSettings = (settings: unknown[]) => ({
      ...base,
      pigcode: { ...base.pigcode, contributes: { provider: { id: "fake", settings } } },
    })
    expect(() =>
      pluginManifestSchema.parse(
        withSettings([
          { key: "binaryPath", type: "text", label: "A" },
          { key: "binaryPath", type: "text", label: "B" },
        ]),
      ),
    ).toThrow(/duplicate setting key/)
    expect(() =>
      pluginManifestSchema.parse(withSettings([{ key: "customModels", type: "text", label: "M" }])),
    ).toThrow(/reserved/)
  })

  it("only accepts an https homepage, the only kind the desktop app opens", () => {
    const withHomepage = (homepage: string) => ({
      ...base,
      pigcode: { ...base.pigcode, contributes: { provider: { id: "fake", homepage } } },
    })
    const manifest = pluginManifestSchema.parse(withHomepage("https://example.com/agent"))
    expect(readProviderContribution(manifest)?.homepage).toBe("https://example.com/agent")
    expect(() => pluginManifestSchema.parse(withHomepage("http://example.com"))).toThrow()
    expect(() => pluginManifestSchema.parse(withHomepage("javascript:alert(1)"))).toThrow()
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

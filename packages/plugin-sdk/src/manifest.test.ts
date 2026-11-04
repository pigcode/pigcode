/** 验证 manifest 结构与 apiVersion/engines 兼容性。 */
import { describe, expect, it } from "vitest"
import {
  checkPluginCompatibility,
  isAgentPlugin,
  parsePluginManifest,
  pluginManifestSchema,
  readAgentContribution,
} from "./manifest"

const base = {
  name: "@pigcode/agent-fake",
  version: "0.0.0",
  pigcode: {
    apiVersion: 1,
    kind: "agent",
    host: "./index.mjs",
    inject: ["agents"],
    provides: ["agent:fake"],
    contributes: {},
    permissions: ["process:spawn"],
  },
}

describe("plugin manifest", () => {
  it("accepts a valid manifest", () => {
    const manifest = pluginManifestSchema.parse(base)
    expect(manifest.pigcode.kind).toBe("agent")
  })

  it("rejects a plugin without host or client entry", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        pigcode: { ...base.pigcode, host: undefined },
      }),
    ).toThrow()
  })

  it("reads an incompatible api version so the error can name both versions", () => {
    // 不兼容的版本照常读出 manifest，由兼容性检查给出插件需要的版本和 Host 支持的版本。
    const manifest = pluginManifestSchema.parse({
      ...base,
      pigcode: { ...base.pigcode, apiVersion: 2 },
    })
    expect(manifest.pigcode.apiVersion).toBe(2)
    expect(checkPluginCompatibility(manifest)).toBe(
      "unsupported plugin apiVersion: 2; this Host supports 1",
    )
  })

  it("rejects an api version that is not an integer", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        pigcode: { ...base.pigcode, apiVersion: "1" },
      }),
    ).toThrow()
  })

  it("reads the agent contribution with its settings fields", () => {
    const manifest = pluginManifestSchema.parse({
      ...base,
      pigcode: {
        ...base.pigcode,
        contributes: {
          agent: {
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
    const agent = readAgentContribution(manifest)
    expect(agent?.id).toBe("fake")
    expect(agent?.customModels).toBe(true)
    expect(agent?.settings.map((field) => field.key)).toEqual(["binaryPath", "environment"])
    expect(agent?.settings[0]).toMatchObject({ type: "path", pathKind: "file" })
  })

  it("infers a bare agent contribution from provides", () => {
    const agent = readAgentContribution(pluginManifestSchema.parse(base))
    expect(agent).toMatchObject({ id: "fake", settings: [], customModels: true })
  })

  it("rejects duplicate or reserved setting keys", () => {
    const withSettings = (settings: unknown[]) => ({
      ...base,
      pigcode: { ...base.pigcode, contributes: { agent: { id: "fake", settings } } },
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
      pigcode: { ...base.pigcode, contributes: { agent: { id: "fake", homepage } } },
    })
    const manifest = pluginManifestSchema.parse(withHomepage("https://example.com/agent"))
    expect(readAgentContribution(manifest)?.homepage).toBe("https://example.com/agent")
    expect(() => pluginManifestSchema.parse(withHomepage("http://example.com"))).toThrow()
    expect(() => pluginManifestSchema.parse(withHomepage("javascript:alert(1)"))).toThrow()
  })
})

describe("the old provider names in the manifest", () => {
  it("rejects each old name with the new name to use instead", () => {
    const old = {
      ...base,
      pigcode: {
        ...base.pigcode,
        kind: "provider",
        provides: ["provider:fake"],
        contributes: { provider: { id: "fake" } },
      },
    }
    expect(() => parsePluginManifest(old)).toThrow(
      'invalid plugin manifest: pigcode.kind: kind "provider" was renamed to "agent" (see docs/plugin-authoring.md); ' +
        'pigcode.provides.0: provides "provider:fake" was renamed to "agent:fake" (see docs/plugin-authoring.md); ' +
        "pigcode.contributes.provider: contributes.provider was renamed to contributes.agent (see docs/plugin-authoring.md)",
    )
  })

  it("only counts kind agent as an Agent plugin", () => {
    expect(isAgentPlugin(pluginManifestSchema.parse(base))).toBe(true)
    expect(isAgentPlugin({ pigcode: { kind: "provider" } })).toBe(false)
    expect(isAgentPlugin({ pigcode: { kind: "capability" } })).toBe(false)
  })
})

describe("contributes fields the host does not read", () => {
  const withContributes = (contributes: Record<string, unknown>) => ({
    ...base,
    pigcode: { ...base.pigcode, contributes },
  })

  it.each([
    ["settings", "ctx.settingsPages.register"],
    ["commands", "ctx.commands.register"],
    ["slots", "ctx.panels, ctx.surfaces or ctx.settingsPages"],
    ["rpc", "plugins cannot add RPC methods"],
  ])("rejects contributes.%s and says where to register instead", (key, hint) => {
    expect(() => parsePluginManifest(withContributes({ [key]: {} }))).toThrow(
      new RegExp(`pigcode\\.contributes\\.${key}: contributes\\.${key} is no longer read: `),
    )
    expect(() => parsePluginManifest(withContributes({ [key]: {} }))).toThrow(hint)
  })

  it("keeps other metadata and the agent contribution as they are", () => {
    const manifest = pluginManifestSchema.parse(
      withContributes({ agent: { id: "fake" }, "x-note": "kept" }),
    )
    expect(manifest.pigcode.contributes).toEqual({ agent: { id: "fake" }, "x-note": "kept" })
  })

  it("keeps metadata whose key is also a name on Object.prototype", () => {
    const manifest = pluginManifestSchema.parse(withContributes({ constructor: 1, toString: 2 }))
    expect(Object.entries(manifest.pigcode.contributes)).toEqual([
      ["constructor", 1],
      ["toString", 2],
    ])
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

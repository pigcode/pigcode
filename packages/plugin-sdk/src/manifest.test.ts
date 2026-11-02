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

  it("rejects an incompatible api version", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...base,
        pigcode: { ...base.pigcode, apiVersion: 2 },
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

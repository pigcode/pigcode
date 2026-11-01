/** 验证 manifest 结构与 apiVersion/engines 兼容性。 */
import { describe, expect, it } from "vitest"
import {
  checkPluginCompatibility,
  isAgentPlugin,
  pluginManifestSchema,
  readAgentContribution,
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

describe("agent names in the manifest", () => {
  const contribution = {
    id: "fake",
    description: { "zh-CN": "测试用", "en-US": "For tests" },
    settings: [{ key: "binaryPath", type: "path", label: "Binary path" }],
  }
  /** 同一个插件分别用旧名字（provider）和新名字（agent）写。 */
  const withNames = (name: "agent" | "provider", value: unknown = contribution) => ({
    ...base,
    pigcode: {
      ...base.pigcode,
      kind: name,
      provides: [`${name}:fake`, "capability:other"],
      contributes: { [name]: value, commands: [] },
    },
  })

  it("parses the agent names into the same result as the provider names", () => {
    const agent = pluginManifestSchema.parse(withNames("agent"))
    const provider = pluginManifestSchema.parse(withNames("provider"))
    expect(agent).toEqual(provider)
    expect(agent.pigcode.kind).toBe("provider")
    expect(agent.pigcode.provides).toEqual(["provider:fake", "capability:other"])
    expect(Object.keys(agent.pigcode.contributes).sort()).toEqual(["commands", "provider"])
    expect(readAgentContribution(agent)).toEqual(readAgentContribution(provider))
    expect(readAgentContribution(agent)?.settings[0]).toMatchObject({ pathKind: "file" })
  })

  it("infers a bare contribution from provides agent:<id>", () => {
    const manifest = pluginManifestSchema.parse({
      ...base,
      pigcode: { ...base.pigcode, kind: "agent", provides: ["agent:fake"] },
    })
    expect(readAgentContribution(manifest)).toMatchObject({ id: "fake", settings: [] })
  })

  it("reads contributes.agent and agent:<id> from a manifest that was not parsed", () => {
    const manifest = {
      ...base,
      pigcode: { ...base.pigcode, kind: "provider" as const, provides: [], contributes: {} },
    } as unknown as Parameters<typeof readAgentContribution>[0]
    const declared = {
      ...manifest,
      pigcode: { ...manifest.pigcode, contributes: { agent: { id: "x" } } },
    }
    expect(readAgentContribution(declared)?.id).toBe("x")
    const provided = { ...manifest, pigcode: { ...manifest.pigcode, provides: ["agent:y"] } }
    expect(readAgentContribution(provided)?.id).toBe("y")
  })

  it("reports the same errors for the same mistakes under either name", () => {
    const issues = (name: "agent" | "provider") => {
      const settings = [
        { key: "binaryPath", type: "text", label: "A" },
        { key: "binaryPath", type: "text", label: "B" },
      ]
      const result = pluginManifestSchema.safeParse(withNames(name, { id: "Bad id", settings }))
      if (result.success) throw new Error("expected the manifest to be rejected")
      return result.error.issues.map((issue) => ({ message: issue.message, path: issue.path }))
    }
    const agent = issues("agent")
    expect(agent.map((issue) => issue.message)).toContain("duplicate setting key: binaryPath")
    expect(agent.every((issue) => issue.path[2] === "agent")).toBe(true)
    const renamed = agent.map((issue) => ({
      ...issue,
      path: issue.path.map((part, index) => (index === 2 ? "provider" : part)),
    }))
    expect(renamed).toEqual(issues("provider"))
  })

  it("rejects a manifest that mixes the agent names with the provider names", () => {
    const mixed = (pigcode: Record<string, unknown>) =>
      pluginManifestSchema.safeParse({ ...base, pigcode: { ...base.pigcode, ...pigcode } })
    const cases = [
      { kind: "agent", provides: [], contributes: { provider: { id: "fake" } } },
      { kind: "provider", provides: [], contributes: { agent: { id: "fake" } } },
      { kind: "bundle", provides: [], contributes: { agent: { id: "a" }, provider: { id: "b" } } },
      { kind: "agent", provides: ["provider:fake"] },
      { kind: "provider", provides: ["agent:fake"] },
    ]
    for (const pigcode of cases) {
      const result = mixed(pigcode)
      expect(result.success, JSON.stringify(pigcode)).toBe(false)
      expect(result.error?.issues).toHaveLength(1)
      expect(result.error?.issues[0]).toMatchObject({
        path: ["pigcode"],
        message: expect.stringMatching(/^use either the agent names or the old provider names/),
      })
    }
    expect(mixed(cases[0]!).error?.issues[0]?.message).toContain(
      'found kind "agent" and contributes.provider',
    )
  })

  it("treats both kinds as Agent plugins", () => {
    expect(isAgentPlugin({ pigcode: { kind: "agent" } })).toBe(true)
    expect(isAgentPlugin(pluginManifestSchema.parse(withNames("agent")))).toBe(true)
    expect(isAgentPlugin(pluginManifestSchema.parse(base))).toBe(true)
    expect(isAgentPlugin({ pigcode: { kind: "capability" } })).toBe(false)
  })

  it("keeps readProviderContribution as the same function", () => {
    expect(readProviderContribution).toBe(readAgentContribution)
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

/** 验证旧名字（provider）数据迁移的规则：搬键、改插件 id、新旧并存时新的为准、重复执行不改动。 */
import { describe, expect, it } from "vitest"
import { migrateLegacyPluginEntries, migrateLegacySettings } from "./legacy-names"

describe("settings migration", () => {
  it("moves the agent settings and the default agent to the new keys", () => {
    const { values, changed } = migrateLegacySettings({
      "providers.claude": { binaryPath: "/opt/claude" },
      "providers.codex": { customModels: ["gpt-x"] },
      "agents.defaultProvider": "codex",
      "appearance.theme": "dark",
    })
    expect(changed).toBe(true)
    expect(values).toEqual({
      "agents.claude": { binaryPath: "/opt/claude" },
      "agents.codex": { customModels: ["gpt-x"] },
      defaultAgent: "codex",
      "appearance.theme": "dark",
    })
  })

  it("keeps the new key when both exist and drops the old one", () => {
    const { values, changed } = migrateLegacySettings({
      "providers.claude": { binaryPath: "/old" },
      "agents.claude": { binaryPath: "/new" },
      "agents.defaultProvider": "claude",
      defaultAgent: "codex",
    })
    expect(changed).toBe(true)
    expect(values).toEqual({ "agents.claude": { binaryPath: "/new" }, defaultAgent: "codex" })
  })

  it("never mistakes the settings of an Agent whose id is defaultProvider for the default key", () => {
    // 第一次启动：旧的默认键与 id 叫 defaultProvider 的 Agent 的旧设置同时存在。
    const first = migrateLegacySettings({
      "agents.defaultProvider": "codex",
      "providers.defaultProvider": { binaryPath: "/opt/dp" },
    })
    expect(first.values).toEqual({
      defaultAgent: "codex",
      "agents.defaultProvider": { binaryPath: "/opt/dp" },
    })
    // 以后的启动：`agents.defaultProvider` 是这个 Agent 的设置，不管有没有 defaultAgent 都不动它。
    expect(migrateLegacySettings(first.values)).toEqual({ values: first.values, changed: false })
    const withoutDefault = { "agents.defaultProvider": { binaryPath: "/opt/dp" } }
    expect(migrateLegacySettings(withoutDefault)).toEqual({
      values: withoutDefault,
      changed: false,
    })
  })

  it("changes nothing the second time", () => {
    const first = migrateLegacySettings({ "providers.claude": { a: 1 }, other: true })
    const second = migrateLegacySettings(first.values)
    expect(second.changed).toBe(false)
    expect(second.values).toEqual(first.values)
  })

  it("does not touch the input", () => {
    const input = { "providers.claude": { a: 1 } }
    migrateLegacySettings(input)
    expect(input).toEqual({ "providers.claude": { a: 1 } })
  })
})

describe("plugins.yml migration", () => {
  it("renames old plugin ids and the renamed built-in packages, keeping states and order", () => {
    const { entries, changed } = migrateLegacyPluginEntries([
      {
        id: "provider.@pigcode/provider-claude",
        name: "@pigcode/provider-claude",
        builtin: true,
        disabled: true,
      },
      { id: "ui.pigcode-ui-debug-panel", name: "pigcode-ui-debug-panel", disabled: false },
      {
        id: "provider.pigcode-provider-echo",
        name: "pigcode-provider-echo",
        config: { a: 1 },
        disabled: false,
      },
    ])
    expect(changed).toBe(true)
    expect(entries).toEqual([
      {
        id: "agent.@pigcode/agent-claude",
        name: "@pigcode/agent-claude",
        builtin: true,
        disabled: true,
      },
      { id: "ui.pigcode-ui-debug-panel", name: "pigcode-ui-debug-panel", disabled: false },
      // 用户安装的插件只改 id：包名与安装目录不变。
      {
        id: "agent.pigcode-provider-echo",
        name: "pigcode-provider-echo",
        config: { a: 1 },
        disabled: false,
      },
    ])
  })

  it("keeps the new entry when the old and the new id both exist", () => {
    const { entries } = migrateLegacyPluginEntries([
      { id: "provider.pigcode-echo", name: "pigcode-echo", disabled: true },
      { id: "agent.pigcode-echo", name: "pigcode-echo", disabled: false },
      { id: "provider.pigcode-other", name: "pigcode-other" },
      { id: "provider.pigcode-other", name: "pigcode-other", disabled: true },
    ])
    expect(entries).toEqual([
      { id: "agent.pigcode-echo", name: "pigcode-echo", disabled: false },
      { id: "agent.pigcode-other", name: "pigcode-other" },
    ])
  })

  it("changes nothing the second time", () => {
    const first = migrateLegacyPluginEntries([
      { id: "provider.@pigcode/provider-codex", name: "@pigcode/provider-codex", builtin: true },
    ])
    const second = migrateLegacyPluginEntries(first.entries)
    expect(second.changed).toBe(false)
    expect(second.entries).toEqual(first.entries)
  })
})

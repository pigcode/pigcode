/** 验证 Agent 的新名字：旧名字是指向新名字的别名，旧命令名和新命令名共用参数 schema。 */
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  agentContributionSchema,
  agentEventSchema,
  agentFeaturesSchema,
  agentModelSchema,
  agentSettingFieldSchema,
  agentSettingsValuesSchema,
  agentStatusSchema,
  commandAliases,
  commandSchemas,
  parseCommandParams,
  providerCapabilitiesSchema,
  providerContributionSchema,
  providerEventSchema,
  providerModelSchema,
  providerSettingFieldSchema,
  providerSettingsValuesSchema,
  providerStatusSchema,
  resolveCommandMethod,
  type AgentContribution,
  type AgentEvent,
  type AgentFeatures,
  type AgentModel,
  type AgentSettingField,
  type AgentSettingFieldInput,
  type AgentSettingsValues,
  type AgentStatus,
  type CanonicalCommandMethod,
  type CommandParams,
  type ProviderCapabilities,
  type ProviderContribution,
  type ProviderEvent,
  type ProviderModel,
  type ProviderSettingField,
  type ProviderSettingFieldInput,
  type ProviderSettingsValues,
  type ProviderStatus,
} from "./index"

describe("agent type names", () => {
  it("keeps every old type name as the same type", () => {
    expectTypeOf<ProviderCapabilities>().toEqualTypeOf<AgentFeatures>()
    expectTypeOf<ProviderModel>().toEqualTypeOf<AgentModel>()
    expectTypeOf<ProviderSettingField>().toEqualTypeOf<AgentSettingField>()
    expectTypeOf<ProviderSettingFieldInput>().toEqualTypeOf<AgentSettingFieldInput>()
    expectTypeOf<ProviderContribution>().toEqualTypeOf<AgentContribution>()
    expectTypeOf<ProviderSettingsValues>().toEqualTypeOf<AgentSettingsValues>()
    expectTypeOf<ProviderStatus>().toEqualTypeOf<AgentStatus>()
    expectTypeOf<ProviderEvent>().toEqualTypeOf<AgentEvent>()
  })

  it("keeps every old schema name as the same schema", () => {
    expect(providerCapabilitiesSchema).toBe(agentFeaturesSchema)
    expect(providerModelSchema).toBe(agentModelSchema)
    expect(providerSettingFieldSchema).toBe(agentSettingFieldSchema)
    expect(providerContributionSchema).toBe(agentContributionSchema)
    expect(providerSettingsValuesSchema).toBe(agentSettingsValuesSchema)
    expect(providerStatusSchema).toBe(agentStatusSchema)
    expect(providerEventSchema).toBe(agentEventSchema)
  })
})

describe("agent command names", () => {
  it("forwards each old command name to its new name with the same params schema", () => {
    expect(commandAliases).toEqual({
      "provider.detect": "agent.detect",
      "provider.list": "agent.registered",
      "provider.default": "agent.default",
      "provider.models": "agent.models",
      "thread.switchProvider": "thread.switchAgent",
    })
    for (const [alias, target] of Object.entries(commandAliases)) {
      expect(commandSchemas[alias as keyof typeof commandAliases]).toBe(commandSchemas[target])
      expect(resolveCommandMethod(alias as keyof typeof commandAliases)).toBe(target)
    }
    // agent.list 是设置页的列表，不是 provider.list 的新名字。
    expect(resolveCommandMethod("agent.list")).toBe("agent.list")
    expect(parseCommandParams("provider.models", { agentId: "codex" })).toEqual(
      parseCommandParams("agent.models", { agentId: "codex" }),
    )
    expect(() => parseCommandParams("agent.models", {})).toThrow()
  })

  it("types the params of both names the same way", () => {
    expectTypeOf<CommandParams<"provider.detect">>().toEqualTypeOf<CommandParams<"agent.detect">>()
    expectTypeOf<CommandParams<"provider.list">>().toEqualTypeOf<
      CommandParams<"agent.registered">
    >()
    expectTypeOf<CommandParams<"provider.default">>().toEqualTypeOf<
      CommandParams<"agent.default">
    >()
    expectTypeOf<CommandParams<"provider.models">>().toEqualTypeOf<CommandParams<"agent.models">>()
    expectTypeOf<CommandParams<"thread.switchProvider">>().toEqualTypeOf<
      CommandParams<"thread.switchAgent">
    >()
    expectTypeOf(resolveCommandMethod).returns.toEqualTypeOf<CanonicalCommandMethod>()
    expectTypeOf<"provider.list">().not.toExtend<CanonicalCommandMethod>()
  })
})

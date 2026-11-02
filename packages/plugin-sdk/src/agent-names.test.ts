/** 验证 Agent driver 的新名字：旧名字是别名，旧名字的 driver 仍用旧字段 `capabilities`。 */
import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  AgentDriver,
  AgentModelInfo,
  AgentRegistry,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  AgentStatus,
  LegacyAgentDriver,
  PluginHostContext,
  PluginProviderRuntime,
  PluginProviderSession,
  ProviderDriver,
  ProviderModelInfo,
  ProviderPluginDriver,
  ProviderRuntime,
  ProviderSessionHandle,
  ProviderSettingsValues,
  ProviderStatus,
} from "./index"
import type { AgentFeatures } from "@pigcode/contracts"
import { agentFeaturesOf } from "./index"
import { agentEnvironment, providerEnvironment } from "./node"

const features: AgentFeatures = {
  streaming: true,
  approvals: false,
  questions: false,
  plan: false,
  resume: false,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: false,
  images: false,
  usage: false,
  modelCatalog: false,
  nativeSessionId: false,
}

describe("agent driver names", () => {
  it("keeps every old type name as the same type", () => {
    expectTypeOf<ProviderSessionHandle>().toEqualTypeOf<AgentSessionHandle>()
    expectTypeOf<PluginProviderSession>().toEqualTypeOf<AgentSessionHandle>()
    expectTypeOf<ProviderRuntime>().toEqualTypeOf<AgentRuntime>()
    expectTypeOf<PluginProviderRuntime>().toEqualTypeOf<AgentRuntime>()
    expectTypeOf<ProviderModelInfo>().toEqualTypeOf<AgentModelInfo>()
    expectTypeOf<ProviderSettingsValues>().toEqualTypeOf<AgentSettingsValues>()
    expectTypeOf<ProviderStatus>().toEqualTypeOf<AgentStatus>()
  })

  it("types the old driver names with the old features field", () => {
    expectTypeOf<ProviderDriver>().toEqualTypeOf<LegacyAgentDriver>()
    expectTypeOf<ProviderPluginDriver>().toEqualTypeOf<LegacyAgentDriver>()
    expectTypeOf<AgentDriver["features"]>().toEqualTypeOf<AgentFeatures>()
    expectTypeOf<LegacyAgentDriver["capabilities"]>().toEqualTypeOf<AgentFeatures>()
  })

  it("reads the Agent features from either field", () => {
    const driver = { id: "x", features } as unknown as AgentDriver
    const legacy = { id: "x", capabilities: features } as unknown as LegacyAgentDriver
    expect(agentFeaturesOf(driver)).toBe(features)
    expect(agentFeaturesOf(legacy)).toBe(features)
  })

  it("keeps ctx.providers as the deprecated name of ctx.agents", () => {
    expectTypeOf<PluginHostContext["agents"]>().toEqualTypeOf<AgentRegistry>()
    expectTypeOf<PluginHostContext["providers"]>().toEqualTypeOf<AgentRegistry>()
    expect(providerEnvironment).toBe(agentEnvironment)
  })
})

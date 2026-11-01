/** 验证 Agent driver 的新名字：旧名字是指向新名字的别名。 */
import { describe, expectTypeOf, it } from "vitest"
import type {
  AgentDriver,
  AgentModelInfo,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  AgentStatus,
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

describe("agent driver names", () => {
  it("keeps every old type name as the same type", () => {
    expectTypeOf<ProviderDriver>().toEqualTypeOf<AgentDriver>()
    expectTypeOf<ProviderPluginDriver>().toEqualTypeOf<AgentDriver>()
    expectTypeOf<ProviderSessionHandle>().toEqualTypeOf<AgentSessionHandle>()
    expectTypeOf<PluginProviderSession>().toEqualTypeOf<AgentSessionHandle>()
    expectTypeOf<ProviderRuntime>().toEqualTypeOf<AgentRuntime>()
    expectTypeOf<PluginProviderRuntime>().toEqualTypeOf<AgentRuntime>()
    expectTypeOf<ProviderModelInfo>().toEqualTypeOf<AgentModelInfo>()
    expectTypeOf<ProviderSettingsValues>().toEqualTypeOf<AgentSettingsValues>()
    expectTypeOf<ProviderStatus>().toEqualTypeOf<AgentStatus>()
  })
})

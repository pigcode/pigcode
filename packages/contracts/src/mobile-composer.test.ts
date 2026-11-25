import { describe, expect, it } from "vitest"
import {
  legacyMobileDraftCreateParams,
  legacyMobileStartRunParams,
  mobileCommandJsonSchemas,
  mobileComposerChangedNotice,
  mobileComposerJsonSchemas,
  mobileComposerMethods,
  mobileContextUsage,
  mobileDraftCreateParams,
  mobileDraftJsonSchemas,
  mobileDraftModels,
  mobileDraftOptions,
  mobileFeatures,
  mobileSetPermissionModeParams,
  mobileSetPlanModeParams,
  mobileStartRunParams,
  mobileSwitchAgentParams,
  mobileThreadComposerState,
  mobileThreadReference,
  mobileTimelineJsonSchemas,
  mobileTimelineSubscription,
} from "./index"

describe("mobile composer contracts", () => {
  it("declares composer.controls in mobileFeatures and exposes composer method names", () => {
    expect(mobileFeatures).toContain("composer.controls")
    expect(mobileComposerMethods).toEqual({
      switchAgent: "thread.switchAgent",
      setPermissionMode: "thread.setPermissionMode",
      setPlanMode: "thread.setPlanMode",
      composerChanged: "thread.composer",
    })
  })

  it("validates context usage, composer state, control params, and notices", () => {
    expect(
      mobileContextUsage.parse({
        usedTokens: 0,
        maxTokens: 200_000,
        autoCompactTokens: null,
      }),
    ).toEqual({ usedTokens: 0, maxTokens: 200_000, autoCompactTokens: null })
    expect(mobileContextUsage.safeParse({ usedTokens: -1 }).success).toBe(false)
    expect(mobileContextUsage.safeParse({ usedTokens: 10, extra: true }).success).toBe(false)

    const composer = {
      instanceId: "claude-work",
      agentId: "claude",
      modelId: "claude-sonnet-4-5",
      permissionMode: "auto-accept-edits" as const,
      planMode: true,
      supportsPlanMode: true,
      contextUsage: {
        usedTokens: 42_000,
        maxTokens: 200_000,
        autoCompactTokens: 170_000,
      },
    }
    expect(mobileThreadComposerState.parse(composer)).toEqual(composer)
    expect(
      mobileThreadComposerState.parse({
        instanceId: "fake",
        agentId: "fake",
        modelId: null,
        permissionMode: "full-access",
        planMode: false,
        supportsPlanMode: false,
        contextUsage: null,
      }),
    ).toMatchObject({ modelId: null, contextUsage: null })

    expect(
      mobileSwitchAgentParams.parse({
        threadId: "th_1",
        instanceId: "fake",
        modelId: "fake-sage",
      }),
    ).toEqual({ threadId: "th_1", instanceId: "fake", modelId: "fake-sage" })
    expect(mobileSwitchAgentParams.parse({ threadId: "th_1", instanceId: "fake" })).toEqual({
      threadId: "th_1",
      instanceId: "fake",
    })
    expect(
      mobileSetPermissionModeParams.parse({
        threadId: "th_1",
        permissionMode: "approval-required",
      }),
    ).toEqual({ threadId: "th_1", permissionMode: "approval-required" })
    expect(
      mobileSetPermissionModeParams.safeParse({ threadId: "th_1", permissionMode: "plan" }).success,
    ).toBe(false)
    expect(mobileSetPlanModeParams.parse({ threadId: "th_1", planMode: true })).toEqual({
      threadId: "th_1",
      planMode: true,
    })
    expect(mobileComposerChangedNotice.parse({ threadId: "th_1", composer })).toEqual({
      threadId: "th_1",
      composer,
    })
  })

  it("extends timeline subscription, draft catalog, and run/draft params while preserving legacy strict schemas", () => {
    expect(
      mobileTimelineSubscription.parse({
        page: { events: [], through: 0 },
        composer: {
          instanceId: "fake",
          agentId: "fake",
          permissionMode: "full-access",
          planMode: false,
          supportsPlanMode: true,
        },
      }),
    ).toMatchObject({ composer: { instanceId: "fake", supportsPlanMode: true } })

    expect(
      mobileDraftOptions.parse({
        defaultInstanceId: "fake",
        instances: [
          {
            instanceId: "fake",
            label: "Fake Agent",
            agentName: "Fake Agent",
            permissionModes: ["full-access"],
            defaultPermissionMode: "full-access",
            agentId: "fake",
            accentColor: "#3b82f6",
            supportsPlanMode: true,
          },
        ],
      }),
    ).toMatchObject({
      instances: [{ agentId: "fake", accentColor: "#3b82f6", supportsPlanMode: true }],
    })

    expect(
      mobileDraftModels.parse({
        defaultModelId: "fake-sage",
        models: [
          {
            id: "fake-sage",
            label: "Fake Sage",
            efforts: ["low", "medium", "high"],
            fast: true,
            ultracode: true,
          },
        ],
      }),
    ).toMatchObject({
      models: [{ id: "fake-sage", efforts: ["low", "medium", "high"], fast: true, ultracode: true }],
    })

    const ref = mobileThreadReference.parse({
      kind: "thread",
      threadId: "th_ref",
      title: "引用的会话",
    })
    const startWithExtras = {
      commandId: "11111111-1111-4111-8111-111111111111",
      threadId: "th_1",
      text: "hello",
      effort: "high",
      fast: true,
      ultracode: true,
      references: [ref],
    }
    expect(mobileStartRunParams.parse(startWithExtras)).toEqual(startWithExtras)
    expect(legacyMobileStartRunParams.safeParse(startWithExtras).success).toBe(false)

    const draftWithExtras = {
      commandId: "22222222-2222-4222-8222-222222222222",
      projectId: "pr_1",
      instanceId: "fake",
      modelId: "fake-sage",
      permissionMode: "auto-accept-edits" as const,
      text: "create",
      effort: "max",
      fast: false,
      ultracode: true,
      planMode: true,
      references: [ref],
    }
    expect(mobileDraftCreateParams.parse(draftWithExtras)).toEqual(draftWithExtras)
    expect(legacyMobileDraftCreateParams.safeParse(draftWithExtras).success).toBe(false)
    expect(
      mobileStartRunParams.safeParse({
        ...startWithExtras,
        references: Array.from({ length: 11 }, (_, i) => ({
          kind: "thread" as const,
          threadId: `th_${i}`,
          title: `T${i}`,
        })),
      }).success,
    ).toBe(false)
  })

  it("exports JSON schemas without error", () => {
    expect(mobileComposerJsonSchemas()).toHaveProperty("MobileThreadComposerState")
    expect(mobileDraftJsonSchemas()).toHaveProperty("MobileDraftModel")
    expect(mobileCommandJsonSchemas()).toHaveProperty("MobileStartRunParams")
    expect(mobileTimelineJsonSchemas()).toHaveProperty("MobileTimelineSubscription")
  })
})

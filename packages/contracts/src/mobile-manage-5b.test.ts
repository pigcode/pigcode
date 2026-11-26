import { describe, expect, it } from "vitest"
import {
  mobileFeatures,
  mobileMarketplacePluginSchema,
  mobileMarketplaceSummarySchema,
  mobilePluginIdParamsSchema,
  mobilePluginInstallFromMarketplaceParamsSchema,
  mobilePluginListResultSchema,
  mobilePluginMarketplacesResultSchema,
  mobilePluginMethods,
  mobilePluginMutationResultSchema,
  mobilePluginRefreshMarketplacesParamsSchema,
  mobilePluginSetEnabledParamsSchema,
  mobilePluginSummarySchema,
  mobilePluginUninstallResultSchema,
  mobileScheduleCreateParamsSchema,
  mobileScheduleDeleteResultSchema,
  mobileScheduleDeleteRunParamsSchema,
  mobileScheduleDeleteRunResultSchema,
  mobileScheduleIdParamsSchema,
  mobileScheduleListResultSchema,
  mobileScheduleMethods,
  mobileScheduleRunNowResultSchema,
  mobileScheduleRunsParamsSchema,
  mobileScheduleRunsResultSchema,
  mobileScheduleSchema,
  mobileScheduleUpdateParamsSchema,
} from "./index"

describe("mobile management 5B contracts", () => {
  it("declares schedules.manage and plugins.manage within the mobile hello feature budget", () => {
    expect(mobileFeatures).toContain("schedules.manage")
    expect(mobileFeatures).toContain("plugins.manage")
    expect(mobileFeatures.length).toBeLessThanOrEqual(32)
    expect(Object.keys(mobileScheduleMethods)).toHaveLength(7)
    expect(Object.keys(mobilePluginMethods)).toHaveLength(7)
  })

  it("validates schedule params and strips desktop draft from mobile schedule schema", () => {
    const now = "2026-11-26T09:00:00.000Z"
    const created = mobileScheduleCreateParamsSchema.safeParse({
      projectId: "pr_1",
      title: "  每日巡检  ",
      prompt: "  检查测试状态  ",
      rule: { kind: "daily", time: "09:30" },
      endsAt: null,
      enabled: true,
      execution: {
        instanceId: "claude",
        modelId: "claude-sonnet",
        effort: "medium",
        permissionMode: "full-access",
      },
    })
    expect(created).toMatchObject({
      success: true,
      data: { title: "每日巡检", prompt: "检查测试状态" },
    })

    // Reject empty/whitespace prompt, >20000 prompt, >120 title, invalid rule, or model without instanceId
    expect(
      mobileScheduleCreateParamsSchema.safeParse({
        projectId: "pr_1",
        prompt: "   ",
        rule: { kind: "daily", time: "09:00" },
      }).success,
    ).toBe(false)
    expect(
      mobileScheduleCreateParamsSchema.safeParse({
        projectId: "pr_1",
        prompt: "a".repeat(20_001),
        rule: { kind: "daily", time: "09:00" },
      }).success,
    ).toBe(false)
    expect(
      mobileScheduleCreateParamsSchema.safeParse({
        projectId: "pr_1",
        title: "t".repeat(121),
        prompt: "ok",
        rule: { kind: "daily", time: "09:00" },
      }).success,
    ).toBe(false)
    expect(
      mobileScheduleCreateParamsSchema.safeParse({
        projectId: "pr_1",
        prompt: "ok",
        rule: { kind: "daily", time: "25:99" },
      }).success,
    ).toBe(false)
    expect(
      mobileScheduleCreateParamsSchema.safeParse({
        projectId: "pr_1",
        prompt: "ok",
        rule: { kind: "daily", time: "09:00" },
        execution: { modelId: "claude-sonnet", permissionMode: "full-access" },
      }).success,
    ).toBe(false)

    // Update, id, runs pagination defaults & bounds
    expect(
      mobileScheduleUpdateParamsSchema.safeParse({ id: "sch_1", enabled: false, endsAt: now })
        .success,
    ).toBe(true)
    expect(mobileScheduleUpdateParamsSchema.safeParse({ id: "" }).success).toBe(false)
    expect(mobileScheduleIdParamsSchema.safeParse({ id: "sch_1" }).success).toBe(true)
    expect(mobileScheduleIdParamsSchema.safeParse({ id: "" }).success).toBe(false)
    expect(mobileScheduleRunsParamsSchema.parse({ id: "sch_1" })).toEqual({
      id: "sch_1",
      limit: 20,
      offset: 0,
    })
    expect(mobileScheduleRunsParamsSchema.safeParse({ id: "sch_1", limit: 51 }).success).toBe(false)
    expect(mobileScheduleRunsParamsSchema.safeParse({ id: "sch_1", offset: -1 }).success).toBe(
      false,
    )
    expect(mobileScheduleDeleteRunParamsSchema.safeParse({ id: "srun_1" }).success).toBe(true)

    const validSchedule = {
      id: "sch_1",
      target: {
        kind: "project" as const,
        projectId: "pr_1",
        execution: { permissionMode: "full-access" as const },
      },
      projectName: "Pigcode",
      threadTitle: null,
      title: "每日巡检",
      prompt: "检查测试状态",
      rule: { kind: "daily" as const, time: "09:30" },
      endsAt: null,
      enabled: true,
      status: "active" as const,
      nextRunAt: now,
      lastRunAt: null,
      lastRunId: null,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    expect(mobileScheduleSchema.safeParse(validSchedule).success).toBe(true)
    // Strict schema rejects desktop TipTap draft field
    expect(
      mobileScheduleSchema.safeParse({ ...validSchedule, draft: { document: "{}" } }).success,
    ).toBe(false)
    expect(
      mobileScheduleListResultSchema.safeParse({ schedules: [validSchedule], truncated: false })
        .success,
    ).toBe(true)
    expect(mobileScheduleDeleteResultSchema.safeParse({ deleted: true }).success).toBe(true)
    expect(
      mobileScheduleRunNowResultSchema.safeParse({ status: "started", runId: "run_1" }).success,
    ).toBe(true)
    expect(
      mobileScheduleRunNowResultSchema.safeParse({ status: "unknown", runId: null }).success,
    ).toBe(false)
    expect(
      mobileScheduleRunsResultSchema.safeParse({
        total: 1,
        runs: [
          {
            id: "srun_1",
            scheduleId: "sch_1",
            source: "manual",
            status: "succeeded",
            threadId: "th_1",
            runId: "run_1",
            error: null,
            triggeredAt: now,
            finishedAt: now,
          },
        ],
      }).success,
    ).toBe(true)
    expect(mobileScheduleDeleteRunResultSchema.safeParse({ deleted: false }).success).toBe(true)
  })

  it("validates sanitized plugin and marketplace schemas and rejects forbidden desktop fields", () => {
    const validPlugin = {
      id: "ui.demo-plugin",
      name: "demo-plugin",
      displayName: "Demo Plugin",
      description: "A sample plugin",
      version: "1.2.0",
      kind: "ui" as const,
      enabled: true,
      builtin: false,
      apiVersion: 1,
      permissions: ["workspace.read"],
      provides: [],
      conflict: null,
      error: null,
      originKind: "marketplace" as const,
      marketplaceId: "pigcode",
      marketplacePluginName: "demo-plugin",
      originLabel: "demo-plugin@pigcode",
      canUpdate: true,
    }
    expect(mobilePluginSummarySchema.safeParse(validPlugin).success).toBe(true)
    expect(
      mobilePluginSummarySchema.safeParse({ ...validPlugin, kind: "capability" }).success,
    ).toBe(true)
    // Reject contributes leakage
    expect(mobilePluginSummarySchema.safeParse({ ...validPlugin, contributes: {} }).success).toBe(
      false,
    )
    expect(
      mobilePluginListResultSchema.safeParse({ plugins: [validPlugin], truncated: false }).success,
    ).toBe(true)
    expect(mobilePluginMutationResultSchema.safeParse({ plugin: validPlugin }).success).toBe(true)
    expect(mobilePluginUninstallResultSchema.safeParse({ uninstalled: true }).success).toBe(true)
    expect(mobilePluginUninstallResultSchema.safeParse({ uninstalled: false }).success).toBe(false)

    expect(
      mobilePluginSetEnabledParamsSchema.safeParse({ id: "ui.demo-plugin", enabled: false })
        .success,
    ).toBe(true)
    expect(mobilePluginSetEnabledParamsSchema.safeParse({ id: "", enabled: true }).success).toBe(
      false,
    )
    expect(mobilePluginIdParamsSchema.safeParse({ id: "ui.demo-plugin" }).success).toBe(true)
    expect(
      mobilePluginRefreshMarketplacesParamsSchema.safeParse({ id: "pigcode", ifStale: true })
        .success,
    ).toBe(true)
    expect(
      mobilePluginInstallFromMarketplaceParamsSchema.safeParse({
        marketplace: "pigcode",
        name: "demo-plugin",
      }).success,
    ).toBe(true)
    expect(
      mobilePluginInstallFromMarketplaceParamsSchema.safeParse({ marketplace: "", name: "x" })
        .success,
    ).toBe(false)

    const validEntry = {
      name: "demo-plugin",
      displayName: "Demo Plugin",
      description: "Desc",
      version: "1.3.0",
      category: "productivity",
      iconUrl: "https://example.com/icon.png",
      homepage: "https://example.com",
      author: "Pigcode",
      publisherType: "official" as const,
      displayNameI18n: { "zh-CN": "示例插件", en: "Demo Plugin" },
      descriptionI18n: { "zh-CN": "示例描述" },
      sourceLabel: "https://example.com/demo.tgz",
    }
    expect(mobileMarketplacePluginSchema.safeParse(validEntry).success).toBe(true)
    // Reject inline data: icons or oversized icon URLs
    expect(
      mobileMarketplacePluginSchema.safeParse({
        ...validEntry,
        iconUrl: "data:image/png;base64,AAAA",
      }).success,
    ).toBe(false)
    expect(
      mobileMarketplacePluginSchema.safeParse({
        ...validEntry,
        iconUrl: `https://example.com/${"a".repeat(500)}`,
      }).success,
    ).toBe(false)

    const validMarket = {
      id: "pigcode",
      official: true,
      displayName: "Pigcode",
      description: "Official marketplace",
      owner: "Pigcode",
      sourceType: "url" as const,
      sourceLabel: "https://marketplace.pigcode.dev/marketplace.json",
      sourceUrl: "https://github.com/pigcode/marketplace",
      enabled: true,
      lastUpdated: "2026-11-26T00:00:00.000Z",
      error: null,
      plugins: [validEntry],
    }
    expect(mobileMarketplaceSummarySchema.safeParse(validMarket).success).toBe(true)
    // Reject sourcePath leakage
    expect(
      mobileMarketplaceSummarySchema.safeParse({ ...validMarket, sourcePath: "/Users/me/mkt" })
        .success,
    ).toBe(false)
    expect(
      mobilePluginMarketplacesResultSchema.safeParse({
        marketplaces: [validMarket],
        truncated: false,
      }).success,
    ).toBe(true)
  })
})

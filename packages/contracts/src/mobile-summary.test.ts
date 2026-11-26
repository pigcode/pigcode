import { describe, expect, it } from "vitest"
import {
  mobileComputerSummaryResultSchema,
  mobileFeatures,
  mobileSummaryCountsSchema,
  mobileSummaryItemSchema,
  mobileSummaryMaxItems,
  mobileSummaryMethods,
  mobileSummaryParamsSchema,
  mobileSummaryPreviewLimit,
} from "./index"

describe("mobile computer summary contracts", () => {
  const validComputerId = "a".repeat(64)
  const now = "2026-11-26T15:00:00.000Z"

  const validItem = {
    threadId: "th_1",
    projectId: "pr_1",
    projectName: "Pigcode",
    title: "修复构建脚本",
    updatedAt: now,
    status: "waiting-approval" as const,
    pendingKind: "approval" as const,
    pendingPreview: "运行测试命令",
    unread: true,
    pinned: false,
    agentName: "Claude",
  }

  const validCounts = {
    attention: 1,
    error: 1,
    unread: 2,
    working: 1,
    total: 8,
  }

  it("declares computer.summary within the mobile hello feature budget", () => {
    expect(mobileFeatures).toContain("computer.summary")
    expect(mobileFeatures.length).toBeLessThanOrEqual(32)
    expect(mobileSummaryMethods.summary).toBe("mobile.summary")
    expect(mobileSummaryMaxItems).toBe(50)
    expect(mobileSummaryPreviewLimit).toBe(120)
  })

  it("strictly validates mobileSummaryParamsSchema", () => {
    expect(mobileSummaryParamsSchema.safeParse({}).success).toBe(true)
    expect(mobileSummaryParamsSchema.safeParse({ extra: true }).success).toBe(false)
  })

  it("validates mobileSummaryCountsSchema bounds and rejects unknown fields", () => {
    expect(mobileSummaryCountsSchema.safeParse(validCounts).success).toBe(true)
    expect(
      mobileSummaryCountsSchema.safeParse({
        attention: 0,
        error: 0,
        unread: 0,
        working: 0,
        total: 0,
      }).success,
    ).toBe(true)
    expect(mobileSummaryCountsSchema.safeParse({ ...validCounts, attention: -1 }).success).toBe(
      false,
    )
    expect(mobileSummaryCountsSchema.safeParse({ ...validCounts, total: 1.5 }).success).toBe(false)
    expect(mobileSummaryCountsSchema.safeParse({ ...validCounts, extra: 0 }).success).toBe(false)
  })

  it("validates mobileSummaryItemSchema fields, lengths, enums, and strict keys", () => {
    expect(mobileSummaryItemSchema.safeParse(validItem).success).toBe(true)
    expect(
      mobileSummaryItemSchema.safeParse({
        threadId: "th_2",
        projectId: "pr_1",
        projectName: "Pigcode",
        title: "普通未读",
        updatedAt: now,
        status: "completed",
        unread: true,
        pinned: true,
      }).success,
    ).toBe(true)

    expect(mobileSummaryItemSchema.safeParse({ ...validItem, threadId: "" }).success).toBe(false)
    expect(mobileSummaryItemSchema.safeParse({ ...validItem, projectId: "" }).success).toBe(false)
    expect(
      mobileSummaryItemSchema.safeParse({ ...validItem, projectName: "p".repeat(513) }).success,
    ).toBe(false)
    expect(
      mobileSummaryItemSchema.safeParse({ ...validItem, title: "t".repeat(513) }).success,
    ).toBe(false)
    expect(
      mobileSummaryItemSchema.safeParse({ ...validItem, agentName: "a".repeat(513) }).success,
    ).toBe(false)
    expect(
      mobileSummaryItemSchema.safeParse({
        ...validItem,
        pendingPreview: "x".repeat(mobileSummaryPreviewLimit + 1),
      }).success,
    ).toBe(false)
    expect(mobileSummaryItemSchema.safeParse({ ...validItem, pendingPreview: "" }).success).toBe(
      false,
    )
    expect(mobileSummaryItemSchema.safeParse({ ...validItem, updatedAt: "not-a-date" }).success).toBe(
      false,
    )
    expect(mobileSummaryItemSchema.safeParse({ ...validItem, status: "unknown" }).success).toBe(
      false,
    )
    expect(mobileSummaryItemSchema.safeParse({ ...validItem, pendingKind: "other" }).success).toBe(
      false,
    )
    expect(
      mobileSummaryItemSchema.safeParse({ ...validItem, command: "rm -rf /" }).success,
    ).toBe(false)
  })

  it("validates mobileComputerSummaryResultSchema bounds and strictness", () => {
    const validResult = {
      computerId: validComputerId,
      computerName: "Mac Studio",
      syncedAt: now,
      counts: validCounts,
      items: [validItem],
      truncated: false,
    }
    expect(mobileComputerSummaryResultSchema.safeParse(validResult).success).toBe(true)

    const atCap = Array.from({ length: mobileSummaryMaxItems }, (_, index) => ({
      ...validItem,
      threadId: `th_${index}`,
    }))
    expect(
      mobileComputerSummaryResultSchema.safeParse({
        ...validResult,
        items: atCap,
        truncated: true,
      }).success,
    ).toBe(true)

    const overCap = [...atCap, { ...validItem, threadId: "th_over" }]
    expect(
      mobileComputerSummaryResultSchema.safeParse({
        ...validResult,
        items: overCap,
        truncated: true,
      }).success,
    ).toBe(false)

    expect(
      mobileComputerSummaryResultSchema.safeParse({ ...validResult, computerId: "short" }).success,
    ).toBe(false)
    expect(
      mobileComputerSummaryResultSchema.safeParse({ ...validResult, computerName: "" }).success,
    ).toBe(false)
    expect(
      mobileComputerSummaryResultSchema.safeParse({
        ...validResult,
        computerName: "c".repeat(81),
      }).success,
    ).toBe(false)
    expect(
      mobileComputerSummaryResultSchema.safeParse({ ...validResult, syncedAt: "2026/11/26" })
        .success,
    ).toBe(false)
    expect(
      mobileComputerSummaryResultSchema.safeParse({ ...validResult, extraField: 1 }).success,
    ).toBe(false)
  })
})

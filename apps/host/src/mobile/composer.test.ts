import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FAKE_CONTEXT_USAGE } from "../agents/fake"
import { createRecordingDriver, setupComposerHarness } from "./composer.test-helpers"

describe("mobile composer.controls protocol", () => {
  it("keeps legacy clients fully isolated when composer.controls is not negotiated", async () => {
    const harness = await setupComposerHarness([
      "timeline.read",
      "run.write",
      "draft.write",
      "sidebar.read",
    ])
    try {
      const project = harness.ctx.projects.add("/tmp/mobile-legacy-composer", "旧客户端")
      const custom = harness.ctx.agents.createInstance("fake", "带颜色实例", {
        accentColor: "#3B82F6",
      })
      const thread = harness.ctx.threads.create(project.id, "旧会话", "fake")
      harness.ctx.sessions.append({
        threadId: thread.id,
        runId: "r1",
        type: "context.updated",
        payload: FAKE_CONTEXT_USAGE,
        schemaVersion: 1,
        createdAt: "2026-11-25T10:00:00.000Z",
      })

      const options = await harness.mobileCall("thread.draftOptions")
      const instances = (options.result as { instances: Array<Record<string, unknown>> }).instances
      const found = instances.find((item) => item.instanceId === custom.instanceId)!
      expect(found).not.toHaveProperty("agentId")
      expect(found).not.toHaveProperty("accentColor")
      expect(found).not.toHaveProperty("supportsPlanMode")

      const models = await harness.mobileCall("thread.draftModels", { instanceId: "fake" })
      const firstModel = (models.result as { models: Array<Record<string, unknown>> }).models[0]!
      expect(firstModel).toEqual({ id: "fake-sage", label: "Fake Sage" })

      const sub = await harness.mobileCall("thread.subscribe", { threadId: thread.id })
      expect(sub.result).not.toHaveProperty("composer")

      await harness.desktopCall("thread.setPermissionMode", {
        threadId: thread.id,
        permissionMode: "approval-required",
      })
      expect(
        harness.mobileNotifications.filter(
          (item) => (item as { method?: string }).method === "thread.composer",
        ),
      ).toEqual([])

      expect(
        await harness.mobileCall("thread.switchAgent", {
          threadId: thread.id,
          instanceId: custom.instanceId,
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
      expect(
        await harness.mobileCall("thread.setPermissionMode", {
          threadId: thread.id,
          permissionMode: "auto",
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
      expect(
        await harness.mobileCall("thread.setPlanMode", {
          threadId: thread.id,
          planMode: true,
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })

      expect(
        await harness.mobileCall("run.start", {
          commandId: randomUUID(),
          threadId: thread.id,
          text: "legacy rejected",
          effort: "high",
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      expect(
        await harness.mobileCall("thread.create", {
          commandId: randomUUID(),
          projectId: project.id,
          instanceId: "fake",
          permissionMode: "full-access",
          text: "legacy draft rejected",
          planMode: true,
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
    } finally {
      await harness.dispose()
    }
  })

  it("exposes extended draft options and model features when composer.controls is negotiated", async () => {
    const noPlan = createRecordingDriver({
      id: "no-plan",
      displayName: "No Plan Agent",
      plan: false,
      permissions: ["full-access"],
    })
    const harness = await setupComposerHarness(["composer.controls"], [noPlan.driver])
    try {
      const colored = harness.ctx.agents.createInstance("fake", "工作区实例", {
        accentColor: "#3B82F6",
      })
      const options = await harness.mobileCall("thread.draftOptions")
      expect(options.result).toMatchObject({
        instances: expect.arrayContaining([
          expect.objectContaining({
            instanceId: colored.instanceId,
            agentId: "fake",
            accentColor: "#3b82f6",
            supportsPlanMode: true,
          }),
          expect.objectContaining({
            instanceId: "no-plan",
            agentId: "no-plan",
            supportsPlanMode: false,
            permissionModes: ["full-access"],
          }),
        ]),
      })

      const models = await harness.mobileCall("thread.draftModels", { instanceId: "fake" })
      expect(models.result).toEqual({
        defaultModelId: "fake-sage",
        models: [
          {
            id: "fake-sage",
            label: "Fake Sage",
            efforts: ["low", "medium", "high", "max"],
            fast: true,
            ultracode: true,
          },
          {
            id: "fake-swift",
            label: "Fake Swift",
            efforts: [],
            fast: false,
            ultracode: false,
          },
        ],
      })

      // Without draft.write, thread.create remains unavailable even though catalog reads work.
      expect(
        await harness.mobileCall("thread.create", {
          commandId: randomUUID(),
          projectId: "pr_none",
          instanceId: "fake",
          permissionMode: "full-access",
          text: "blocked",
        }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
    } finally {
      await harness.dispose()
    }
  })

  it("projects composer state and context usage, resets on agent switch or resume failure, and syncs desktop <-> mobile", async () => {
    const second = createRecordingDriver({
      id: "second",
      displayName: "Second Agent",
      plan: true,
    })
    const harness = await setupComposerHarness(
      ["timeline.read", "timeline.resume", "composer.controls"],
      [second.driver],
    )
    try {
      const project = harness.ctx.projects.add("/tmp/mobile-composer-sync", "双向同步")
      const thread = harness.ctx.threads.create(project.id, "同步会话", "fake", undefined, {
        modelId: "fake-sage",
        permissionMode: "auto-accept-edits",
        planMode: false,
      })

      await harness.desktopCall("thread.subscribe", { threadId: thread.id, cursor: 0 })
      const sub = await harness.mobileCall("thread.subscribe", { threadId: thread.id })
      expect(sub.result).toMatchObject({
        composer: {
          instanceId: "fake",
          agentId: "fake",
          modelId: "fake-sage",
          permissionMode: "auto-accept-edits",
          planMode: false,
          supportsPlanMode: true,
          contextUsage: null,
        },
      })

      // Emit context.updated -> pushes thread.composer with usage.
      harness.ctx.sessions.append({
        threadId: thread.id,
        runId: "r1",
        type: "context.updated",
        payload: FAKE_CONTEXT_USAGE,
        schemaVersion: 1,
        createdAt: "2026-11-25T10:01:00.000Z",
      })
      const composerNotices = () =>
        harness.mobileNotifications
          .filter((item) => (item as { method?: string }).method === "thread.composer")
          .map((item) => (item as { params: { threadId: string; composer: unknown } }).params)
      expect(composerNotices().at(-1)).toEqual({
        threadId: thread.id,
        composer: {
          instanceId: "fake",
          agentId: "fake",
          modelId: "fake-sage",
          permissionMode: "auto-accept-edits",
          planMode: false,
          supportsPlanMode: true,
          contextUsage: FAKE_CONTEXT_USAGE,
        },
      })

      // Title-only thread.updated must NOT reset contextUsage or emit duplicate composer notice.
      const beforeTitleCount = composerNotices().length
      harness.ctx.sessions.append({
        threadId: thread.id,
        runId: "r1",
        type: "thread.updated",
        payload: { title: "重命名标题" },
        schemaVersion: 1,
        createdAt: "2026-11-25T10:01:10.000Z",
      })
      expect(composerNotices()).toHaveLength(beforeTitleCount)

      // notice(session.resumeFailed) resets contextUsage to null and emits both thread.event and thread.composer.
      harness.ctx.sessions.append({
        threadId: thread.id,
        runId: "r2",
        type: "notice",
        payload: { level: "warning", key: "session.resumeFailed" },
        schemaVersion: 1,
        createdAt: "2026-11-25T10:02:00.000Z",
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({ contextUsage: null })
      expect(
        harness.mobileNotifications.some(
          (item) => (item as { method?: string }).method === "thread.event",
        ),
      ).toBe(true)

      // Another context.updated before mobile switchAgent.
      harness.ctx.sessions.append({
        threadId: thread.id,
        runId: "r2",
        type: "context.updated",
        payload: { usedTokens: 50_000, maxTokens: 200_000, autoCompactTokens: null },
        schemaVersion: 1,
        createdAt: "2026-11-25T10:03:00.000Z",
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({
        contextUsage: { usedTokens: 50_000, maxTokens: 200_000, autoCompactTokens: null },
      })

      // Mobile -> Desktop: setPlanMode, setPermissionMode, switchAgent.
      const planOn = await harness.mobileCall("thread.setPlanMode", {
        threadId: thread.id,
        planMode: true,
      })
      expect(planOn.result).toMatchObject({
        planMode: true,
        contextUsage: { usedTokens: 50_000, maxTokens: 200_000, autoCompactTokens: null },
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({ planMode: true })

      const permChanged = await harness.mobileCall("thread.setPermissionMode", {
        threadId: thread.id,
        permissionMode: "approval-required",
      })
      expect(permChanged.result).toMatchObject({
        permissionMode: "approval-required",
        planMode: true,
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({
        permissionMode: "approval-required",
      })

      // Mobile switches agent -> resets contextUsage and syncs to desktop.
      const switched = await harness.mobileCall("thread.switchAgent", {
        threadId: thread.id,
        instanceId: "second",
        modelId: "fake-swift",
      })
      expect(switched.result).toEqual({
        instanceId: "second",
        agentId: "second",
        modelId: "fake-swift",
        permissionMode: "approval-required",
        planMode: true,
        supportsPlanMode: true,
        contextUsage: null,
      })
      expect(composerNotices().at(-1)?.composer).toEqual(switched.result)
      await expect
        .poll(() =>
          harness.desktopNotifications.some(
            (item) =>
              (
                item as {
                  method?: string
                  params?: { type?: string; payload?: { agentId?: string } }
                }
              ).method === "thread.event" &&
              (item as { params?: { type?: string } }).params?.type === "thread.updated" &&
              (item as { params?: { payload?: { agentId?: string } } }).params?.payload?.agentId ===
                "second",
          ),
        )
        .toBe(true)

      // Desktop -> Mobile: desktop changes permission, plan mode, and switches back to fake.
      await harness.desktopCall("thread.setPlanMode", { threadId: thread.id, planMode: false })
      expect(composerNotices().at(-1)?.composer).toMatchObject({ planMode: false })

      await harness.desktopCall("thread.setPermissionMode", {
        threadId: thread.id,
        permissionMode: "full-access",
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({ permissionMode: "full-access" })

      await harness.desktopCall("thread.switchAgent", {
        threadId: thread.id,
        agentId: "fake",
        instanceId: "fake",
        modelId: "fake-sage",
      })
      expect(composerNotices().at(-1)?.composer).toMatchObject({
        instanceId: "fake",
        agentId: "fake",
        modelId: "fake-sage",
        contextUsage: null,
      })

      // Resumed subscribe also includes composer.
      const latestSeq = harness.ctx.sessions.latestSeq(thread.id)
      const resumed = await harness.mobileCall("thread.subscribe", {
        threadId: thread.id,
        after: latestSeq,
      })
      expect(resumed.result).toMatchObject({
        resumed: true,
        composer: {
          instanceId: "fake",
          agentId: "fake",
          modelId: "fake-sage",
          permissionMode: "full-access",
          planMode: false,
          supportsPlanMode: true,
          contextUsage: null,
        },
      })
    } finally {
      await harness.dispose()
    }
  })
})

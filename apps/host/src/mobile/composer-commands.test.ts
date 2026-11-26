import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createRecordingDriver, setupComposerHarness } from "./composer.test-helpers"

describe("mobile composer.controls guards & forwarding", () => {
  it("rejects unauthorized threads, unsupported modes/models, revoked devices, and switching during active runs", async () => {
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => (releaseHold = resolve))
    const busyDriver = createRecordingDriver({
      id: "busy-agent",
      displayName: "Busy Agent",
      plan: true,
      holdGate,
    })
    const restricted = createRecordingDriver({
      id: "restricted",
      displayName: "Restricted Agent",
      plan: false,
      permissions: ["full-access"],
    })
    const harness = await setupComposerHarness(
      ["composer.controls", "run.write"],
      [busyDriver.driver, restricted.driver],
    )
    try {
      const project = harness.ctx.projects.add("/tmp/mobile-composer-guards", "安全边界")
      const removedProject = harness.ctx.projects.add("/tmp/mobile-composer-removed", "待移除")
      const mainThread = harness.ctx.threads.create(project.id, "主会话", "busy-agent")
      const subagent = harness.ctx.threads.create(project.id, "子代理", "busy-agent", mainThread.id)
      const restrictedThread = harness.ctx.threads.create(project.id, "受限会话", "restricted")
      const hiddenThread = harness.ctx.threads.create(removedProject.id, "不可见会话", "fake")
      harness.ctx.projects.remove(removedProject.id)

      const disabled = harness.ctx.agents.createInstance("fake", "已停用实例")
      harness.ctx.agents.updateInstance(disabled.instanceId, { enabled: false })

      // Out-of-scope threads rejected.
      for (const badThreadId of ["th_missing", subagent.id, hiddenThread.id]) {
        expect(
          await harness.mobileCall("thread.switchAgent", {
            threadId: badThreadId,
            instanceId: "fake",
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
        expect(
          await harness.mobileCall("thread.setPermissionMode", {
            threadId: badThreadId,
            permissionMode: "full-access",
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
        expect(
          await harness.mobileCall("thread.setPlanMode", {
            threadId: badThreadId,
            planMode: false,
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }

      // Unsupported permission & plan mode rejected; turning planMode OFF is still allowed.
      expect(
        await harness.mobileCall("thread.setPermissionMode", {
          threadId: restrictedThread.id,
          permissionMode: "approval-required",
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      expect(
        await harness.mobileCall("thread.setPlanMode", {
          threadId: restrictedThread.id,
          planMode: true,
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      expect(
        await harness.mobileCall("thread.setPlanMode", {
          threadId: restrictedThread.id,
          planMode: false,
        }),
      ).toMatchObject({ result: { planMode: false, supportsPlanMode: false } })

      // Disabled instance & unknown model rejected.
      expect(
        await harness.mobileCall("thread.switchAgent", {
          threadId: mainThread.id,
          instanceId: disabled.instanceId,
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      expect(
        await harness.mobileCall("thread.switchAgent", {
          threadId: mainThread.id,
          instanceId: "fake",
          modelId: "no-such-model",
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })

      // Switching to non-plan instance while planMode is ON is rejected.
      expect(
        await harness.mobileCall("thread.setPlanMode", {
          threadId: mainThread.id,
          planMode: true,
        }),
      ).toMatchObject({ result: { planMode: true } })
      expect(
        await harness.mobileCall("thread.switchAgent", {
          threadId: mainThread.id,
          instanceId: "restricted",
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      await harness.mobileCall("thread.setPlanMode", { threadId: mainThread.id, planMode: false })

      // Switching during active run returns THREAD_BUSY.
      const runStart = await harness.mobileCall("run.start", {
        commandId: randomUUID(),
        threadId: mainThread.id,
        text: "hold",
      })
      expect(runStart.result).toMatchObject({ threadId: mainThread.id })
      await expect.poll(() => busyDriver.inputs.length).toBe(1)
      expect(
        await harness.mobileCall("thread.switchAgent", {
          threadId: mainThread.id,
          instanceId: "fake",
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      releaseHold()
      await expect.poll(() => harness.ctx.agents.listRuns()).toEqual([])

      // Revoked device rejected.
      const saved = harness.devices.find(harness.deviceKey)!
      harness.devices.remove(saved)
      expect(
        await harness.mobileCall("thread.setPlanMode", {
          threadId: mainThread.id,
          planMode: true,
        }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      releaseHold()
      await harness.dispose()
    }
  })

  it("forwards effort, fast, ultracode, planMode, and validated references for run.start and thread.create with safe idempotency bindings", async () => {
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => (releaseHold = resolve))
    const recorder = createRecordingDriver({
      id: "recorder",
      displayName: "Recorder",
      plan: true,
      holdGate,
    })
    const noPlan = createRecordingDriver({
      id: "no-plan",
      displayName: "No Plan",
      plan: false,
    })
    const harness = await setupComposerHarness(
      ["composer.controls", "run.write", "draft.write", "queue.write"],
      [recorder.driver, noPlan.driver],
    )
    try {
      const project = harness.ctx.projects.add("/tmp/mobile-composer-forward", "参数透传")
      const removedProject = harness.ctx.projects.add("/tmp/mobile-composer-hidden", "已删项目")
      const refThread = harness.ctx.threads.create(project.id, "参考会话", "recorder")
      harness.ctx.sessions.append({
        threadId: refThread.id,
        runId: "ref-r1",
        type: "message.completed",
        payload: { role: "user", text: "参考历史内容" },
        schemaVersion: 1,
        createdAt: "2026-11-25T09:00:00.000Z",
      })
      const target = harness.ctx.threads.create(project.id, "目标会话", "recorder")
      const subagent = harness.ctx.threads.create(project.id, "子代理", "recorder", target.id)
      const hidden = harness.ctx.threads.create(removedProject.id, "隐藏会话", "recorder")
      harness.ctx.projects.remove(removedProject.id)

      // Invalid references rejected before starting run or creating thread.
      for (const badRef of [subagent.id, hidden.id, "th_missing"]) {
        expect(
          await harness.mobileCall("run.start", {
            commandId: randomUUID(),
            threadId: target.id,
            text: "should fail",
            references: [{ kind: "thread", threadId: badRef, title: "非法" }],
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
        expect(
          await harness.mobileCall("thread.create", {
            commandId: randomUUID(),
            projectId: project.id,
            instanceId: "recorder",
            permissionMode: "full-access",
            text: "should fail",
            references: [{ kind: "thread", threadId: badRef, title: "非法" }],
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }
      expect(recorder.inputs).toEqual([])

      // run.start forwards effort, fast, ultracode, references and preserves binding isolation.
      const runCmdId = randomUUID()
      const runParams = {
        commandId: runCmdId,
        threadId: target.id,
        text: "请结合参考继续",
        effort: "high",
        fast: true,
        ultracode: true,
        references: [{ kind: "thread", threadId: refThread.id, title: "客户端展示名" }],
      }
      const runAccepted = await harness.mobileCall("run.start", runParams)
      expect(runAccepted.result).toMatchObject({ commandId: runCmdId, threadId: target.id })
      // Same params -> idempotent receipt.
      expect((await harness.mobileCall("run.start", runParams)).result).toEqual(runAccepted.result)
      // Same commandId with different effort -> COMMAND_ID_CONFLICT.
      expect(await harness.mobileCall("run.start", { ...runParams, effort: "low" })).toMatchObject({
        error: { code: "COMMAND_ID_CONFLICT" },
      })

      await expect.poll(() => recorder.inputs.length).toBe(1)
      expect(recorder.inputs[0]).toMatchObject({
        text: "请结合参考继续",
        effort: "high",
        fast: true,
        ultracode: true,
      })
      expect(recorder.inputs[0]?.handoff).toContain(refThread.id)
      expect(recorder.inputs[0]?.handoff).toContain("参考历史内容")
      const userEvents = harness.ctx.sessions
        .read(target.id, 0)
        .filter((event) => event.type === "message.completed")
      expect(userEvents[0]?.payload).toMatchObject({
        role: "user",
        text: "请结合参考继续",
        references: [{ kind: "thread", threadId: refThread.id, title: "参考会话" }],
      })

      // Queued message also preserves effort/fast/ultracode/references when drained.
      await expect.poll(() => harness.ctx.agents.listRuns()).toEqual([])
      const holdAccepted = await harness.mobileCall("run.start", {
        commandId: randomUUID(),
        threadId: target.id,
        text: "hold",
      })
      expect(holdAccepted.result).toMatchObject({ threadId: target.id })
      await expect.poll(() => recorder.inputs.length).toBe(2)

      const queuedAccepted = await harness.mobileCall("run.start", {
        commandId: randomUUID(),
        threadId: target.id,
        text: "排队带参数消息",
        effort: "max",
        fast: true,
        ultracode: false,
        references: [{ kind: "thread", threadId: refThread.id, title: "参考会话" }],
      })
      expect(queuedAccepted.result).toMatchObject({ queuedMessageId: expect.any(String) })
      releaseHold()
      await expect.poll(() => recorder.inputs.length).toBe(3)
      expect(recorder.inputs[2]).toMatchObject({
        text: "排队带参数消息",
        effort: "max",
        fast: true,
      })
      expect(recorder.inputs[2]?.ultracode).toBeUndefined()
      expect(recorder.inputs[2]?.handoff).toContain(refThread.id)

      // thread.create rejects planMode: true when instance doesn't support it.
      const beforeThreads = harness.ctx.threads.list(project.id).length
      expect(
        await harness.mobileCall("thread.create", {
          commandId: randomUUID(),
          projectId: project.id,
          instanceId: "no-plan",
          permissionMode: "full-access",
          planMode: true,
          text: "plan unsupported",
        }),
      ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      expect(harness.ctx.threads.list(project.id)).toHaveLength(beforeThreads)

      // thread.create forwards planMode, effort, fast, ultracode, references.
      const draftCmdId = randomUUID()
      const draftParams = {
        commandId: draftCmdId,
        projectId: project.id,
        instanceId: "recorder",
        modelId: "fake-sage",
        permissionMode: "auto-accept-edits",
        planMode: true,
        effort: "max",
        fast: true,
        ultracode: true,
        references: [{ kind: "thread", threadId: refThread.id, title: "参考会话" }],
        text: "新会话带完整参数",
      }
      const draftAccepted = await harness.mobileCall("thread.create", draftParams)
      expect(draftAccepted.result).toMatchObject({
        method: "thread.create",
        commandId: draftCmdId,
        projectId: project.id,
      })
      // Idempotent retry vs conflict when planMode differs.
      expect((await harness.mobileCall("thread.create", draftParams)).result).toEqual(
        draftAccepted.result,
      )
      expect(
        await harness.mobileCall("thread.create", { ...draftParams, planMode: false }),
      ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })

      const createdThreadId = (draftAccepted.result as { threadId: string }).threadId
      expect(harness.ctx.threads.get(createdThreadId)).toMatchObject({
        permissionMode: "auto-accept-edits",
        planMode: true,
        lastModelId: "fake-sage",
      })
      await expect.poll(() => recorder.inputs.length).toBe(4)
      expect(recorder.created.at(-1)).toMatchObject({
        threadId: createdThreadId,
        permissionMode: "auto-accept-edits",
        planMode: true,
        model: "fake-sage",
      })
      expect(recorder.inputs[3]).toMatchObject({
        text: "新会话带完整参数",
        effort: "max",
        fast: true,
        ultracode: true,
      })
      expect(recorder.inputs[3]?.handoff).toContain(refThread.id)

      // Legacy run.start binding remains identical when no extra fields are provided.
      const legacyCmdId = randomUUID()
      const legacyParams = {
        commandId: legacyCmdId,
        threadId: createdThreadId,
        text: "无扩展字段消息",
      }
      const legacyAccepted = await harness.mobileCall("run.start", legacyParams)
      expect((await harness.mobileCall("run.start", legacyParams)).result).toEqual(
        legacyAccepted.result,
      )
      expect(await harness.mobileCall("run.start", { ...legacyParams, fast: true })).toMatchObject({
        error: { code: "COMMAND_ID_CONFLICT" },
      })
    } finally {
      releaseHold()
      await harness.dispose()
    }
  })
})

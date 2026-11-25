import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { expect, describe, it } from "vitest"
import type { AgentDriver, CreateSessionInput, UserInput } from "../agents/driver"
import { FakeAgentDriver, FAKE_CONTEXT_USAGE, FAKE_MODELS } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

interface RecordingDriverOptions {
  id: string
  displayName?: string
  plan?: boolean
  permissions?: Array<"approval-required" | "auto-accept-edits" | "auto" | "full-access">
  holdGate?: Promise<void>
  models?: typeof FAKE_MODELS
}

function createRecordingDriver(options: RecordingDriverOptions) {
  const created: CreateSessionInput[] = []
  const inputs: UserInput[] = []
  const fixture = new FakeAgentDriver()
  const driver: AgentDriver = {
    id: options.id,
    displayName: options.displayName ?? options.id,
    features: fixture.features,
    executionModes: {
      plan: options.plan ?? true,
      ...(options.permissions ? { permissions: options.permissions } : {}),
    },
    detect: () => fixture.detect(),
    listModels: async () => options.models ?? FAKE_MODELS,
    async createSession(input) {
      created.push(input)
      return {
        id: input.sessionId ?? `ps_${options.id}_${created.length}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "full-access",
        planMode: input.planMode ?? false,
        model: input.model ?? null,
      }
    },
    async send(_session, input, runtime) {
      inputs.push(input)
      if (input.text === "hold" && options.holdGate) {
        runtime.emit({ type: "message.delta", text: "holding" })
        await options.holdGate
      }
      runtime.emit({ type: "message.completed", text: `reply:${input.text}` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return { driver, created, inputs }
}

async function setupHarness(features: readonly string[], extraDrivers: AgentDriver[] = []) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  for (const driver of extraDrivers) ctx.agents.register(driver)

  const feed = new ThreadFeed(ctx)
  const desktopWire = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const desktopServer = new RpcServer(ctx, desktopWire.host, feed)
  const desktopNotifications: unknown[] = []
  desktopWire.client.onMessage((message) => {
    const record = message as { method?: string }
    if (record.method) desktopNotifications.push(message)
  })
  desktopServer.start()

  const deviceKey = Buffer.alloc(32, 11).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: 1000 })

  const mobileWire = new MemoryTransport()
  const mobileNotifications: unknown[] = []
  const mobileReplies = new Map<string, (message: unknown) => void>()
  mobileWire.client.onMessage((message) => {
    const record = message as { id?: string; method?: string }
    if (record.id && mobileReplies.has(record.id)) {
      const resolve = mobileReplies.get(record.id)!
      mobileReplies.delete(record.id)
      resolve(message)
    } else if (record.method) {
      mobileNotifications.push(message)
    }
  })

  const mobile = new MobileSidebarRpc(ctx, feed, mobileWire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features,
    relayRevision: () => undefined,
  })
  mobile.start()

  async function mobileCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    const reply = new Promise<unknown>((resolve) => mobileReplies.set(id, resolve))
    mobileWire.client.send({ jsonrpc: "2.0", id, method, params })
    return (await reply) as { id: string; result?: unknown; error?: { code: string } }
  }

  async function desktopCall(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    desktopWire.client.send({ jsonrpc: "2.0", id, method, params })
    for (;;) {
      const message = (await desktopWire.client.next()) as {
        id?: string
        result?: unknown
        error?: { code: string; message: string }
      }
      if (message.id === id) return message
    }
  }

  return {
    ctx,
    feed,
    devices,
    deviceKey,
    mobileNotifications,
    desktopNotifications,
    mobileCall,
    desktopCall,
    async dispose() {
      mobile.stop()
      desktopServer.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

describe("mobile composer.controls protocol", () => {
  it("keeps legacy clients fully isolated when composer.controls is not negotiated", async () => {
    const harness = await setupHarness(["timeline.read", "run.write", "draft.write", "sidebar.read"])
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

  it("exposes extended draft options and model capabilities when composer.controls is negotiated", async () => {
    const noPlan = createRecordingDriver({
      id: "no-plan",
      displayName: "No Plan Agent",
      plan: false,
      permissions: ["full-access"],
    })
    const harness = await setupHarness(["composer.controls"], [noPlan.driver])
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
    const harness = await setupHarness(
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
              (item as { method?: string; params?: { type?: string; payload?: { agentId?: string } } })
                .method === "thread.event" &&
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
    const harness = await setupHarness(
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
    const harness = await setupHarness(
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
      expect(
        await harness.mobileCall("run.start", { ...runParams, effort: "low" }),
      ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })

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
      expect(
        await harness.mobileCall("run.start", { ...legacyParams, fast: true }),
      ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })
    } finally {
      releaseHold()
      await harness.dispose()
    }
  })
})

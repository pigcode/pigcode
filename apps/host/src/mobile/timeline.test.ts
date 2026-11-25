import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { Context } from "cordis"
import { mobilePairingViewSchema, rpcSuccessSchema } from "@pigcode/contracts"
import type { AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MobileTimelineSession } from "./timeline"
import { timelineEvent } from "./timeline-projection"

it("opens recent runs with an ordered live snapshot and keeps earlier tool details available by sequence", async () => {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  const project = ctx.projects.add("/private/timeline", "回环")
  const thread = ctx.threads.create(project.id, "回环会话", "fake")

  function event(
    runId: string,
    type: Parameters<typeof ctx.sessions.append>[0]["type"],
    payload: unknown,
  ) {
    return ctx.sessions.append({
      threadId: thread.id,
      runId,
      type,
      payload,
      schemaVersion: 1,
      createdAt: "2026-11-22T12:00:00.000Z",
    })
  }
  const detail = "输出".repeat(20_000)
  for (const runId of ["old", "previous", "active"]) {
    event(runId, "run.started", { text: "检查" })
    if (runId !== "active") event(runId, "run.completed", {})
  }
  const oldTool = event("active", "tool.completed", { id: "tool-A", name: "read", output: detail })
  ctx.sessions.emitLive(thread.id, "active", { type: "message.delta", text: "已写出的正文" })

  const notifications: unknown[] = []
  const reader = new MobileTimelineSession(ctx, (message) => notifications.push(message))
  try {
    const result = reader.subscribe({ threadId: thread.id })
    expect(new Set(result.page.events.map(({ runId }) => runId))).toEqual(
      new Set(["previous", "active"]),
    )
    expect(result.live).toMatchObject({ runId: "active", revision: 1, text: "已写出的正文" })
    const earlier = reader.history({
      threadId: thread.id,
      through: result.page.through,
      before: result.page.nextBefore!,
    })
    expect(earlier.events[0]?.runId).toBe("old")
    expect(result.page.events.find(({ seq }) => seq === oldTool.seq)).toMatchObject({
      text: Array.from(detail).slice(0, 512).join(""),
      truncated: true,
    })
    const part = reader.content({ threadId: thread.id, seq: oldTool.seq, field: "output" })
    expect(part.text).toBe(detail.slice(0, part.nextOffset))
    expect(part.nextOffset).toBeGreaterThan(0)

    ctx.sessions.emitLive(thread.id, "active", { type: "message.delta", text: "，后续" })
    expect(notifications).toMatchObject([
      {
        method: "thread.delta",
        params: { threadId: thread.id, runId: "active", revision: 2, text: "，后续" },
      },
    ])
    reader.unsubscribe({ threadId: thread.id })
    ctx.sessions.emitLive(thread.id, "active", { type: "message.delta", text: "关闭后不再推送" })
    expect(notifications).toHaveLength(1)

    // A single long run must span multiple pages without moving the original history boundary.
    for (let index = 0; index < 65; index++) {
      event("active", "reasoning.completed", { text: "长".repeat(5000) })
    }
    const longPage = reader.subscribe({ threadId: thread.id }).page
    expect(Buffer.byteLength(JSON.stringify(longPage))).toBeLessThanOrEqual(256 * 1024)
    expect(longPage.nextBefore).toBeDefined()
    const newer = event("active", "message.completed", { role: "assistant", text: "之后的新记录" })
    const seen = new Set(longPage.events.map(({ seq }) => seq))
    let before = longPage.nextBefore
    while (before !== undefined) {
      const page = reader.history({ threadId: thread.id, through: longPage.through, before })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
      for (const { seq } of page.events) {
        expect(seq).toBeLessThan(newer.seq)
        expect(seen.has(seq)).toBe(false)
        seen.add(seq)
      }
      if (page.nextBefore !== undefined) expect(page.nextBefore).toBeLessThan(before)
      before = page.nextBefore
    }
    expect(seen.size).toBe(71)

    reader.close()
    const resumed = new MobileTimelineSession(ctx, () => undefined, false, true)
    try {
      const fallback = resumed.subscribe({ threadId: thread.id, after: newer.seq + 1 })
      expect(fallback).not.toHaveProperty("resumed")
      expect(fallback.page).toMatchObject({ through: newer.seq })
      const caughtUp = resumed.subscribe({ threadId: thread.id, after: longPage.through })
      expect(caughtUp).toMatchObject({ resumed: true, page: { events: [{ seq: newer.seq }] } })
    } finally {
      resumed.close()
    }
  } finally {
    reader.close()
    await ctx.fiber.dispose()
  }
})

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "joins a desktop run midstream over Go WSS and reassembles large timeline pages in Dart",
  async () => {
    let firstSent!: () => void
    let sendMore!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => (firstSent = resolve))
    const more = new Promise<void>((resolve) => (sendMore = resolve))
    const complete = new Promise<void>((resolve) => (finish = resolve))
    const driver: AgentDriver = {
      id: "timeline-fixture",
      displayName: "Timeline fixture",
      features: new FakeAgentDriver().features,
      async createSession(input) {
        return {
          id: input.sessionId ?? "timeline-agent-session",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: null,
          permissionMode: "workspace-write",
          model: null,
        }
      },
      async send(_session, _input, runtime) {
        runtime.emit({ type: "message.delta", text: "已经写出的正文" })
        firstSent()
        await more
        runtime.emit({ type: "message.delta", text: "和接下来的输出" })
        await complete
        runtime.emit({ type: "message.completed", text: "已经写出的正文和接下来的输出" })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }

    let selected = ""
    let toolSeq = 0
    const toolOutput = "内容".repeat(18_000)
    const desktopDeltas: unknown[] = []
    const host = await startMobileHost({
      prepare(ctx) {
        ctx.agents.register(driver)
        const project = ctx.projects.add("/tmp/pigcode-timeline-roundtrip", "时间线验收")
        selected = ctx.threads.create(project.id, "大首屏", driver.id).id
        function append(
          runId: string,
          type: Parameters<typeof ctx.sessions.append>[0]["type"],
          payload: unknown,
        ) {
          return ctx.sessions.append({
            threadId: selected,
            runId,
            type,
            payload,
            schemaVersion: 1,
            createdAt: "2026-11-22T10:00:00.000Z",
          })
        }
        append("old", "run.started", { text: "以前的工作" })
        append("old", "run.completed", {})
        append("previous", "run.started", { text: "大段过程" })
        for (let index = 0; index < 20; index++)
          append("previous", "reasoning.completed", { text: "a".repeat(4500) })
        toolSeq = append("previous", "tool.completed", {
          id: "output",
          name: "read",
          output: toolOutput,
        }).seq
        append("previous", "run.completed", {})
      },
      onDesktopMessage(message) {
        if ((message as { method: string }).method === "thread.delta") desktopDeltas.push(message)
      },
    })
    const phone = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    phone.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk))
    phone.on("error", (error) => (diagnostics += error.message))
    const lines = createInterface({ input: phone.stdout })[Symbol.asyncIterator]()
    function send(action: string, values: Record<string, string>) {
      phone.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...values }) + "\n")
    }
    async function receive() {
      const entry = await lines.next()
      if (entry.done) throw new Error(diagnostics || "Dart verification exited early")
      return JSON.parse(entry.value) as { stage: string; code?: string; bytes?: number }
    }
    async function call(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    try {
      await call("relay.testAndSave", { address, token })
      await call("thread.subscribe", { threadId: selected, cursor: 0 })
      await call("run.start", { threadId: selected, text: "检查进行中的输出" })
      await started
      const view = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      if (!view.attempt?.qr) throw new Error("missing pairing QR")
      send("pair", { qr: view.attempt.qr })
      const phoneCode = await receive()
      const pending = mobilePairingViewSchema.parse(await call("mobile.pairing")).attempt?.candidate
      expect(pending?.code).toBe(phoneCode.code)
      await call("mobile.pairing.confirm", {
        id: view.attempt.id,
        confirmation: pending?.confirmation,
      })
      expect(await receive()).toEqual({ stage: "ready" })

      send("timeline", { threadId: selected, liveText: "已经写出的正文" })
      const opened = await receive()
      expect(opened).toMatchObject({ stage: "timeline", liveText: "已经写出的正文", older: true })
      expect(opened.bytes).toBeGreaterThan(65_535)
      expect(opened.bytes).toBeLessThanOrEqual(256 * 1024)

      sendMore()
      send("timeline", { threadId: selected, liveText: "已经写出的正文和接下来的输出" })
      expect(await receive()).toMatchObject({
        stage: "timeline",
        liveText: "已经写出的正文和接下来的输出",
      })
      expect(desktopDeltas).toMatchObject([
        { params: { threadId: selected, event: { text: "已经写出的正文" } } },
        { params: { threadId: selected, event: { text: "和接下来的输出" } } },
      ])

      finish()
      send("timeline", { threadId: selected, answer: "已经写出的正文和接下来的输出" })
      expect(await receive()).toMatchObject({ stage: "timeline", hasAnswer: true })
      send("earlier", { threadId: selected })
      expect(await receive()).toEqual({ stage: "earlier", hasOldRun: true })
      send("timelineContent", { threadId: selected, seq: String(toolSeq) })
      expect(await receive()).toEqual({ stage: "timelineContent", chars: toolOutput.length })
    } finally {
      sendMore()
      finish()
      phone.stdin.end()
      phone.kill()
      await host.stop()
    }
  },
  45_000,
)

it("sends the desktop snapshot before a delta published while the subscription reply is queued", async () => {
  let threadId = ""
  const order: string[] = []
  const host = await startMobileHost({
    prepare(ctx) {
      const project = ctx.projects.add("/tmp/pigcode-timeline-order", "顺序验收")
      threadId = ctx.threads.create(project.id, "顺序", "fake").id
      ctx.sessions.append({
        threadId,
        runId: "overlap",
        type: "run.started",
        payload: {},
        schemaVersion: 1,
        createdAt: "2026-11-22T10:00:00.000Z",
      })
      ctx.sessions.emitLive(threadId, "overlap", { type: "message.delta", text: "已有" })
      const original = ctx.sessions.subscribeLive
      ctx.sessions.subscribeLive = (id, listener) => {
        const off = original(id, listener)
        queueMicrotask(() =>
          ctx.sessions.emitLive(id, "overlap", { type: "message.delta", text: "新增" }),
        )
        return off
      }
    },
    onDesktopMessage(raw) {
      const message = raw as { id?: string; method?: string }
      if (message.id) order.push("reply")
      if (message.method === "thread.delta") order.push("delta")
    },
  })
  try {
    const reply = rpcSuccessSchema.parse(
      await host.call("thread.subscribe", { threadId, cursor: 0 }),
    )
    expect(reply.result).toMatchObject({ snapshot: { live: { text: "已有" } } })
    await expect.poll(() => order).toEqual(["reply", "delta"])
  } finally {
    await host.stop()
  }
})

it("projects approval.requested toolName or name onto MobileTimelineEvent.name", () => {
  const base = {
    seq: 10,
    threadId: "t1",
    runId: "r1",
    type: "approval.requested" as const,
    schemaVersion: 1 as const,
    createdAt: "2026-11-25T10:00:00.000Z",
  }

  expect(
    timelineEvent({
      ...base,
      payload: { requestId: "req-1", toolName: "Bash", title: "允许运行？" },
    }),
  ).toMatchObject({
    kind: "approval.requested",
    itemId: "req-1",
    name: "Bash",
  })

  expect(
    timelineEvent({
      ...base,
      payload: { id: "req-2", name: "Edit" },
    }),
  ).toMatchObject({
    kind: "approval.requested",
    itemId: "req-2",
    name: "Edit",
  })

  const withoutToolName = timelineEvent({
    ...base,
    payload: { requestId: "req-3", toolName: "   " },
  })
  expect(withoutToolName).toMatchObject({
    kind: "approval.requested",
    itemId: "req-3",
  })
  expect(withoutToolName).not.toHaveProperty("name")
})

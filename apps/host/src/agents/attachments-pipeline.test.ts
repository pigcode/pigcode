import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { ATTACHMENT_STAGING_TTL_MS } from "@pigcode/contracts"
import type { AgentDriver, AgentSessionHandle, UserInput } from "./driver"
import { FakeAgentDriver } from "./fake"
import { buildSelection } from "./handoff-builder"
import { handoffForRun } from "./handoff-delivery"
import { apply as agentsPlugin } from "./registry"
import { apply as attachmentsPlugin } from "../services/attachments"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { HandoffStore } from "../storage/handoff-store"
import { ThreadItemStore } from "../storage/thread-items"
import { timelineEvent } from "../mobile/timeline-projection"

function validPng(width = 1170, height = 2532): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function makeRecordingDriver(id: string, images: boolean) {
  const inputs: UserInput[] = []
  let releaseGate: (() => void) | undefined
  let gate: Promise<void> | undefined
  const driver: AgentDriver = {
    id,
    displayName: id,
    features: { ...new FakeAgentDriver().features, images },
    async createSession(input) {
      return {
        id: input.sessionId ?? `ps_${id}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "full-access",
        model: input.model ?? null,
      }
    },
    async send(_session: AgentSessionHandle, input, runtime) {
      inputs.push(input)
      if (gate) await gate
      runtime.emit({ type: "message.completed", text: `${id} ok` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return {
    driver,
    inputs,
    block() {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    unblock() {
      releaseGate?.()
      gate = undefined
    },
  }
}

async function setup(now?: () => number) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(attachmentsPlugin, now ? { now } : {})
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const nativeDriver = makeRecordingDriver("native-img", true)
  const fallbackDriver = makeRecordingDriver("no-img", false)
  ctx.agents.register(nativeDriver.driver)
  ctx.agents.register(fallbackDriver.driver)
  const project = ctx.projects.add("/tmp/pigcode-att-pipeline")
  return { ctx, project, nativeDriver, fallbackDriver }
}

describe("attachment run pipeline, queue, auto-title, fallback, and handoff", () => {
  it("commits attachments, writes lightweight metadata to message.completed, and auto-titles image-only threads", async () => {
    const { ctx, project, nativeDriver } = await setup()
    try {
      const threadNamed = ctx.threads.create(project.id, "新会话", "native-img")
      const namedAtt = ctx.attachments.saveStaging({
        buffer: validPng(1170, 2532),
        fileName: "login-error.png",
      })
      const run1 = await ctx.agents.startRun(threadNamed.id, "", undefined, {
        attachmentIds: [namedAtt.id],
      })
      await run1.done

      expect(ctx.threads.get(threadNamed.id)?.title).toBe("login-error.png")
      expect(nativeDriver.inputs[0]?.text).toBe("")
      expect(nativeDriver.inputs[0]?.attachments).toHaveLength(1)
      expect(nativeDriver.inputs[0]?.attachments?.[0]?.path).toContain(`${namedAtt.id}.png`)

      const userEvent = ctx.sessions
        .read(threadNamed.id, 0)
        .find(
          (event) =>
            event.type === "message.completed" &&
            (event.payload as { role?: string }).role === "user",
        )
      expect(userEvent?.payload).toEqual({
        role: "user",
        text: "",
        attachments: [namedAtt],
      })
      // Must NOT leak local disk path into persisted event payload
      expect(JSON.stringify(userEvent?.payload)).not.toContain(ctx.attachments.dir)

      // Mobile timeline projection exposes attachments on message.user
      expect(timelineEvent(userEvent!)).toMatchObject({
        kind: "message.user",
        text: "",
        attachments: [namedAtt],
      })

      // Generic default filename falls back to 「图片消息」
      const threadGeneric = ctx.threads.create(project.id, "新会话", "native-img")
      const genericAtt = ctx.attachments.saveStaging({
        buffer: validPng(800, 600),
        fileName: "image.png",
      })
      await (
        await ctx.agents.startRun(threadGeneric.id, "", undefined, {
          attachmentIds: [genericAtt.id],
        })
      ).done
      expect(ctx.threads.get(threadGeneric.id)?.title).toBe("图片消息")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("injects fallback path hints once for non-image drivers and leaves native-image drivers untouched", async () => {
    const { ctx, project, fallbackDriver } = await setup()
    try {
      const thread = ctx.threads.create(project.id, "Fallback", "no-img")
      const att = ctx.attachments.saveStaging({
        buffer: validPng(1170, 2532),
        fileName: "crash.png",
      })
      await (
        await ctx.agents.startRun(thread.id, "看看这个报错", undefined, {
          attachmentIds: [att.id],
        })
      ).done

      const expectedPath = ctx.attachments.getPath(att.id, thread.id)!
      expect(fallbackDriver.inputs[0]?.text).toBe(
        `看看这个报错\n\n[Attached image: ${expectedPath} (image/png, 1170x2532)]`,
      )
      expect(fallbackDriver.inputs[0]?.attachments?.[0]?.path).toBe(expectedPath)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("commits queued message attachments immediately, exposes them in snapshot/withdraw, and delivers them on drain", async () => {
    let clock = Date.parse("2026-11-25T10:00:00.000Z")
    const { ctx, project, nativeDriver } = await setup(() => clock)
    try {
      const thread = ctx.threads.create(project.id, "Queue", "native-img")
      nativeDriver.block()
      await ctx.messageQueue.submit(thread.id, "first")

      const attA = ctx.attachments.saveStaging({
        buffer: validPng(640, 480),
        fileName: "queued-a.png",
      })
      const attB = ctx.attachments.saveStaging({
        buffer: validPng(320, 240),
        fileName: "queued-b.png",
      })

      const q1 = await ctx.messageQueue.submit(thread.id, "", { attachmentIds: [attA.id] })
      const q2 = await ctx.messageQueue.submit(thread.id, "with pic", { attachmentIds: [attB.id] })
      if (!("queuedMessageId" in q1) || !("queuedMessageId" in q2)) {
        throw new Error("Expected queued messages")
      }

      // Even after 48h staging TTL cleanup, queued attachments remain committed and intact
      clock += ATTACHMENT_STAGING_TTL_MS * 2
      expect(ctx.attachments.cleanupExpired(clock)).toBe(0)

      const snap = ctx.messageQueue.snapshot(thread.id)
      expect(snap.messages).toMatchObject([
        { id: q1.queuedMessageId, text: "", attachments: [attA] },
        { id: q2.queuedMessageId, text: "with pic", attachments: [attB] },
      ])

      // Withdraw q1 restores attachments in QueueEffect
      const withdrawn = ctx.messageQueue.withdraw(thread.id, q1.queuedMessageId, () => undefined)
      expect(withdrawn).toEqual({
        effect: "withdrawn",
        messageId: q1.queuedMessageId,
        text: "",
        attachments: [attA],
      })

      // Unblock first run -> q2 drains with resolved attachments
      nativeDriver.unblock()
      await expect.poll(() => nativeDriver.inputs.length).toBe(2)
      expect(nativeDriver.inputs[1]?.text).toBe("with pic")
      expect(nativeDriver.inputs[1]?.attachments?.[0]?.id).toBe(attB.id)
      expect(nativeDriver.inputs[1]?.attachments?.[0]?.path).toContain(`${attB.id}.png`)
    } finally {
      nativeDriver.unblock()
      await ctx.fiber.dispose()
    }
  })

  it("keeps image-only user messages in thread_items & handoff with path clues and respects image budget", async () => {
    const { ctx, project, nativeDriver } = await setup()
    try {
      const thread = ctx.threads.create(project.id, "Handoff", "native-img")
      const att = ctx.attachments.saveStaging({
        buffer: validPng(1170, 2532),
        fileName: "diagram.png",
      })
      await (
        await ctx.agents.startRun(thread.id, "", undefined, { attachmentIds: [att.id] })
      ).done

      const items = new ThreadItemStore(ctx.storage.db).list(thread.id)
      expect(items[0]).toMatchObject({
        kind: "user_message",
        text: "",
        attachments: [att],
      })

      const attPath = ctx.attachments.getPath(att.id, thread.id)!
      const selection = buildSelection({
        items,
        heading: "Handoff heading",
        threadId: thread.id,
        budget: 16_000,
        resolveAttachmentPath: (id) => ctx.attachments.getPath(id, thread.id),
      })
      expect(selection?.text).toContain(`[Attached image: ${attPath} (image/png, 1170x2532)]`)

      // Cross-agent switch preserves the image-only turn in handoff text
      const switched = await ctx.agents.switchAgent(thread.id, "no-img", null)
      expect(switched.handoff).toContain(`[Attached image: ${attPath} (image/png, 1170x2532)]`)

      // handoffForRun with many images shrinks budget via handoffBudget({ images })
      const handoffStore = new HandoffStore(ctx.storage.db)
      handoffStore.supersedeSwitches(thread.id)
      handoffStore.create({
        threadId: thread.id,
        strategy: "switch",
        text: "Handoff heading\n\n" + "x".repeat(12_000),
      })
      const delivered = handoffForRun(ctx.storage.db, thread.id, "run_budget", "next", null, {
        images: 6,
        target: { usedTokens: 0, maxTokens: 64_000, autoCompactTokens: null },
        recompose: (_handoff, budget) =>
          buildSelection({
            items,
            heading: "Recomposed",
            threadId: thread.id,
            budget,
            resolveAttachmentPath: (id) => ctx.attachments.getPath(id, thread.id),
          }),
      })
      // 64k window: reserve 16k, 6 images * 8192 = 49152 -> room <= 0 -> budget 0 -> recomposed compact header!
      expect(delivered).toContain("Recomposed")
      expect(delivered).toContain("omitted 2")
      expect(nativeDriver.inputs).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { MOBILE_THUMBNAIL_MAX_BYTES } from "@pigcode/contracts"
import type { AgentDriver, AgentSessionHandle, UserInput } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agentsPlugin } from "../agents/registry"
import { desktopAttachmentThumbnailer } from "../services/attachment-thumbnail"
import { apply as attachmentsPlugin } from "../services/attachments"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

function validPng(width = 160, height = 90, extra = 0): Buffer {
  const buf = Buffer.alloc(33 + extra)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

async function createServer() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(attachmentsPlugin)
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)

  const inputs: UserInput[] = []
  const visionDriver: AgentDriver = {
    id: "vision",
    displayName: "Vision",
    features: { ...new FakeAgentDriver().features, images: true },
    async createSession(input) {
      return {
        id: input.sessionId ?? "ps_vision",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: input.permissionMode ?? "full-access",
        model: null,
      }
    },
    async send(_session: AgentSessionHandle, input, runtime) {
      inputs.push(input)
      runtime.emit({ type: "message.completed", text: "seen" })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  ctx.agents.register(visionDriver)

  const transport = new MemoryTransport({ skip: ["thread.changed", "project.changed", "thread.delta"] })
  const server = new RpcServer(ctx, transport.host)
  server.start()

  const call = async (method: string, params: unknown) => {
    const id = randomUUID()
    transport.client.send({ jsonrpc: "2.0", id, method, params })
    return (await transport.client.next()) as {
      id: string
      result?: unknown
      error?: { code: string; message: string }
    }
  }

  return { ctx, server, call, inputs }
}

describe("desktop attachment RPC & thumbnail bridge", () => {
  it("uploads, reads, enforces thread ownership, and forwards attachmentIds through run.start", async () => {
    const { ctx, server, call, inputs } = await createServer()
    try {
      const project = ctx.projects.add("/tmp/pigcode-rpc-att")
      const threadA = ctx.threads.create(project.id, "新会话", "vision")
      const threadB = ctx.threads.create(project.id, "Other", "vision")
      const png = validPng(640, 480)

      // Rejects SVG with structured error code
      const svgRes = await call("attachment.upload", {
        dataBase64: Buffer.from("<svg></svg>").toString("base64"),
        fileName: "icon.svg",
      })
      expect(svgRes.error?.code).toBe("ATTACHMENT_UNSUPPORTED_TYPE")

      // Uploads valid PNG
      const uploadRes = await call("attachment.upload", {
        dataBase64: png.toString("base64"),
        fileName: "ui-bug.png",
        mimeType: "image/png",
      })
      expect(uploadRes.error).toBeUndefined()
      const attachment = (uploadRes.result as { attachment: { id: string; fileName: string } })
        .attachment
      expect(attachment).toMatchObject({
        id: expect.stringMatching(/^att_/),
        fileName: "ui-bug.png",
        mimeType: "image/png",
        sizeBytes: png.length,
        width: 640,
        height: 480,
      })

      // Starts an image-only run via desktop run.start with commandId
      const startRes = await call("run.start", {
        threadId: threadA.id,
        text: "",
        commandId: randomUUID(),
        attachmentIds: [attachment.id],
      })
      expect(startRes.error).toBeUndefined()
      await expect.poll(() => inputs.length).toBe(1)
      expect(inputs[0]?.text).toBe("")
      expect(inputs[0]?.attachments?.[0]?.id).toBe(attachment.id)
      expect(ctx.threads.get(threadA.id)?.title).toBe("ui-bug.png")

      // Reads attachment with matching threadId
      const readRes = await call("attachment.read", {
        attachmentId: attachment.id,
        threadId: threadA.id,
        variant: "full",
      })
      expect(readRes.result).toEqual({
        attachment,
        mimeType: "image/png",
        dataBase64: png.toString("base64"),
      })

      // Rejects mismatched threadId
      const forbiddenRes = await call("attachment.read", {
        attachmentId: attachment.id,
        threadId: threadB.id,
        variant: "full",
      })
      expect(forbiddenRes.error?.code).toBe("ATTACHMENT_FORBIDDEN")

      // Rejects unknown attachmentId
      const missingRes = await call("attachment.read", { attachmentId: "att_missing" })
      expect(missingRes.error?.code).toBe("ATTACHMENT_NOT_FOUND")
    } finally {
      server.stop()
      await ctx.fiber.dispose()
    }
  })

  it("bridges thumbnail generation over the control transport", async () => {
    const control = new MemoryTransport()
    const thumbBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    control.client.onMessage((msg) => {
      const req = msg as { type?: string; id?: string; maxEdge?: number; maxBytes?: number }
      if (req.type !== "attachment.thumbnail") return
      control.client.send({
        type: "attachment.thumbnail.result",
        id: req.id,
        dataBase64: req.maxEdge === 360 ? thumbBytes.toString("base64") : null,
      })
    })

    const thumbnailer = desktopAttachmentThumbnailer(control.host)
    const ok = await thumbnailer(validPng(1200, 800, MOBILE_THUMBNAIL_MAX_BYTES + 100), {
      maxEdge: 360,
      maxBytes: MOBILE_THUMBNAIL_MAX_BYTES,
    })
    expect(ok).toEqual(thumbBytes)

    const failed = await thumbnailer(validPng(1200, 800), {
      maxEdge: 120,
      maxBytes: MOBILE_THUMBNAIL_MAX_BYTES,
    })
    expect(failed).toBeNull()
  })
})

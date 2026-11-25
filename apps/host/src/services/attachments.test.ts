import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATTACHMENT_STAGING_TTL_MS, MOBILE_THUMBNAIL_MAX_BYTES } from "@pigcode/contracts"
import { apply as attachmentsPlugin, AttachmentError, type AttachmentThumbnailer } from "./attachments"
import { apply as projects } from "./projects"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

function validPng(width = 16, height = 12, extraBytes = 0): Buffer {
  const buf = Buffer.alloc(33 + extraBytes)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(options?: {
  now?: () => number
  thumbnailer?: AttachmentThumbnailer
  useFileDb?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-att-test-"))
  dirs.push(root)
  const ctx = new Context()
  const dbPath = options?.useFileDb ? join(root, "pigcode.db") : ":memory:"
  await ctx.plugin(storage, { path: dbPath })
  await ctx.plugin(attachmentsPlugin, {
    ...(options?.useFileDb ? {} : { attachmentsDir: join(root, "attachments") }),
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.thumbnailer ? { thumbnailer: options.thumbnailer } : {}),
  })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  const project = ctx.projects.add(join(root, "repo"))
  const threadA = ctx.threads.create(project.id, "Thread A", "fake")
  const threadB = ctx.threads.create(project.id, "Thread B", "fake")
  return { ctx, root, project, threadA, threadB }
}

describe("AttachmentsService", () => {
  it("validates magic bytes, size, sha256, mime consistency, and sanitizes fileName on saveStaging", async () => {
    const { ctx, root } = await setup({ useFileDb: true })
    try {
      const png = validPng(1170, 2532)
      const sha256 = createHash("sha256").update(png).digest("hex")
      const saved = ctx.attachments.saveStaging({
        buffer: png,
        fileName: "../../evil/path/\x00screenshot.png",
        expectedSha256: sha256,
        declaredMimeType: "image/png",
      })
      expect(saved).toEqual({
        id: expect.stringMatching(/^att_/),
        mimeType: "image/png",
        fileName: "screenshot.png",
        sizeBytes: png.length,
        width: 1170,
        height: 2532,
      })
      // Stored next to pigcode.db under attachments/<id>.png
      const storedPath = join(root, "attachments", `${saved.id}.png`)
      expect(existsSync(storedPath)).toBe(true)
      expect(await readFile(storedPath)).toEqual(png)

      // Default filename fallback when missing or dot-segments
      const unnamed = ctx.attachments.saveStaging({ buffer: png, fileName: "../" })
      expect(unnamed.fileName).toBe("image.png")

      // Rejects SVG/HTML/text
      expect(() =>
        ctx.attachments.saveStaging({ buffer: Buffer.from("<svg></svg>"), fileName: "a.svg" }),
      ).toThrow(AttachmentError)
      expect(() =>
        ctx.attachments.saveStaging({ buffer: Buffer.from("<html>hi</html>") }),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_UNSUPPORTED_TYPE" }))

      // Rejects declaredMimeType mismatch with real magic bytes
      expect(() =>
        ctx.attachments.saveStaging({ buffer: png, declaredMimeType: "image/jpeg" }),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_UNSUPPORTED_TYPE" }))

      // Rejects oversized buffer
      expect(() =>
        ctx.attachments.saveStaging({ buffer: png, maxBytes: png.length - 1 }),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_TOO_LARGE" }))

      // Rejects sha256 mismatch
      expect(() =>
        ctx.attachments.saveStaging({ buffer: png, expectedSha256: "0".repeat(64) }),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_HASH_MISMATCH" }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("enforces ownerDeviceKey isolation, thread ownership, deduplication, and max 6 on commitForThread", async () => {
    let clock = Date.parse("2026-11-25T10:00:00.000Z")
    const { ctx, threadA, threadB } = await setup({ now: () => clock })
    try {
      const desktopAtt = ctx.attachments.saveStaging({ buffer: validPng(100, 50), fileName: "d.png" })
      const phone1Att = ctx.attachments.saveStaging({
        buffer: validPng(200, 100),
        fileName: "p1.png",
        ownerDeviceKey: "phone-1",
      })
      const phone2Att = ctx.attachments.saveStaging({
        buffer: validPng(300, 150),
        fileName: "p2.png",
        ownerDeviceKey: "phone-2",
      })

      // Phone 2 cannot commit desktop or phone 1 staging attachment
      expect(() =>
        ctx.attachments.commitForThread([desktopAtt.id], threadA.id, "phone-2"),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_FORBIDDEN" }))
      expect(() =>
        ctx.attachments.commitForThread([phone1Att.id], threadA.id, "phone-2"),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_FORBIDDEN" }))
      // Desktop cannot commit phone 1 staging attachment
      expect(() =>
        ctx.attachments.commitForThread([phone1Att.id], threadA.id, null),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_FORBIDDEN" }))

      // Desktop commits its own staging attachment (with duplicate id deduped)
      const committed = ctx.attachments.commitForThread(
        [desktopAtt.id, desktopAtt.id],
        threadA.id,
        null,
      )
      expect(committed).toHaveLength(1)
      expect(committed[0]).toMatchObject({
        id: desktopAtt.id,
        fileName: "d.png",
        mimeType: "image/png",
        width: 100,
        height: 50,
      })
      expect(basename(committed[0]!.path)).toBe(`${desktopAtt.id}.png`)
      expect(existsSync(committed[0]!.path)).toBe(true)

      // Already committed to threadA can be re-referenced in threadA (e.g. from queued message or retry)
      expect(ctx.attachments.commitForThread([desktopAtt.id], threadA.id, null)).toEqual(committed)
      expect(ctx.attachments.resolveForThread([desktopAtt.id], threadA.id)).toEqual(committed)

      // Committed to threadA cannot be committed or resolved for threadB
      expect(() =>
        ctx.attachments.commitForThread([desktopAtt.id], threadB.id, null),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_FORBIDDEN" }))
      expect(() =>
        ctx.attachments.resolveForThread([desktopAtt.id], threadB.id),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_FORBIDDEN" }))

      // Phone 1 commits its own staging attachment
      const phoneCommitted = ctx.attachments.commitForThread([phone1Att.id], threadB.id, "phone-1")
      expect(phoneCommitted[0]?.id).toBe(phone1Att.id)

      // Max 6 unique attachments enforced
      const sevenIds = Array.from({ length: 7 }, () =>
        ctx.attachments.saveStaging({ buffer: validPng() }).id,
      )
      expect(() => ctx.attachments.commitForThread(sevenIds, threadA.id, null)).toThrowError(
        expect.objectContaining({ code: "ATTACHMENT_LIMIT_EXCEEDED" }),
      )

      // Expired staging cannot be committed
      clock += ATTACHMENT_STAGING_TTL_MS + 1000
      expect(() =>
        ctx.attachments.commitForThread([phone2Att.id], threadA.id, "phone-2"),
      ).toThrowError(expect.objectContaining({ code: "ATTACHMENT_NOT_FOUND" }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("reads full bytes, skips thumbnailer for small images, caches generated thumbnails, and cleans up on thread removal or expiry", async () => {
    let clock = Date.parse("2026-11-25T10:00:00.000Z")
    const fakeThumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9])
    const thumbnailer = vi.fn<AttachmentThumbnailer>(async () => fakeThumb)
    const { ctx, root, threadA, threadB } = await setup({ now: () => clock, thumbnailer })
    try {
      const smallPng = validPng(32, 32)
      const largePng = validPng(1200, 800, MOBILE_THUMBNAIL_MAX_BYTES + 1024)
      const small = ctx.attachments.saveStaging({ buffer: smallPng, fileName: "small.png" })
      const large = ctx.attachments.saveStaging({ buffer: largePng, fileName: "large.png" })
      const stagingOnly = ctx.attachments.saveStaging({ buffer: smallPng, fileName: "temp.png" })

      const [smallCommitted, largeCommitted] = ctx.attachments.commitForThread(
        [small.id, large.id],
        threadA.id,
        null,
      )

      // Small image thumb returns original directly without invoking thumbnailer
      const smallThumb = await ctx.attachments.readBytes(small.id, "thumb", { threadId: threadA.id })
      expect(smallThumb.mimeType).toBe("image/png")
      expect(smallThumb.buffer).toEqual(smallPng)
      expect(thumbnailer).not.toHaveBeenCalled()

      // Large image thumb invokes thumbnailer once and caches on disk
      const largeThumb1 = await ctx.attachments.readBytes(large.id, "thumb", { threadId: threadA.id })
      expect(largeThumb1.mimeType).toBe("image/jpeg")
      expect(largeThumb1.buffer).toEqual(fakeThumb)
      expect(thumbnailer).toHaveBeenCalledTimes(1)
      const thumbPath = join(root, "attachments", "thumbs", `${large.id}.jpg`)
      expect(existsSync(thumbPath)).toBe(true)

      // Second read hits disk cache without re-invoking thumbnailer
      const largeThumb2 = await ctx.attachments.readBytes(large.id, "thumb", { threadId: threadA.id })
      expect(largeThumb2.buffer).toEqual(fakeThumb)
      expect(thumbnailer).toHaveBeenCalledTimes(1)

      // Full read returns original PNG
      const largeFull = await ctx.attachments.readBytes(large.id, "full", { threadId: threadA.id })
      expect(largeFull.mimeType).toBe("image/png")
      expect(largeFull.buffer).toEqual(largePng)

      // Foreign threadId rejected
      await expect(
        ctx.attachments.readBytes(large.id, "full", { threadId: threadB.id }),
      ).rejects.toMatchObject({ code: "ATTACHMENT_FORBIDDEN" })

      // cleanupExpired deletes expired staging only, keeps committed
      const stagingPath = join(root, "attachments", `${stagingOnly.id}.png`)
      expect(existsSync(stagingPath)).toBe(true)
      clock += ATTACHMENT_STAGING_TTL_MS + 1000
      expect(ctx.attachments.cleanupExpired(clock)).toBe(1)
      expect(existsSync(stagingPath)).toBe(false)
      expect(existsSync(smallCommitted!.path)).toBe(true)
      expect(existsSync(largeCommitted!.path)).toBe(true)

      // Removing threadA deletes its attachments, thumbnail cache, and DB rows
      expect(ctx.threads.remove(threadA.id)).toBe(true)
      expect(existsSync(smallCommitted!.path)).toBe(false)
      expect(existsSync(largeCommitted!.path)).toBe(false)
      expect(existsSync(thumbPath)).toBe(false)
      await expect(ctx.attachments.readBytes(large.id, "full")).rejects.toMatchObject({
        code: "ATTACHMENT_NOT_FOUND",
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

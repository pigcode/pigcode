import { describe, expect, it } from "vitest"
import {
  ATTACHMENT_STAGING_TTL_MS,
  DESKTOP_MAX_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MOBILE_MAX_IMAGE_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  attachmentReadParamsSchema,
  attachmentReadResultSchema,
  attachmentThumbnailRequestSchema,
  attachmentThumbnailResultSchema,
  attachmentUploadParamsSchema,
  attachmentUploadResultSchema,
  commandSchemas,
  imageAttachmentMimeTypes,
  imageAttachmentSchema,
  legacyMobileDraftCreateParams,
  legacyMobileStartRunParams,
  mobileAttachmentJsonSchemas,
  mobileAttachmentMethods,
  mobileAttachmentReadParams,
  mobileAttachmentReadResult,
  mobileAttachmentUploadCancelParams,
  mobileAttachmentUploadChunkParams,
  mobileAttachmentUploadFinishParams,
  mobileAttachmentUploadFinishResult,
  mobileAttachmentUploadStartParams,
  mobileCommandJsonSchemas,
  mobileDraftCreateParams,
  mobileDraftJsonSchemas,
  mobileFeatures,
  mobileQueueJsonSchemas,
  mobileStartRunParams,
  mobileTimelineEvent,
  mobileTimelineJsonSchemas,
  queueReceipt,
  queuedMessagesSnapshot,
} from "./index"

const sampleAttachment = {
  id: "att_1",
  mimeType: "image/png" as const,
  fileName: "screenshot.png",
  sizeBytes: 1024,
  width: 800,
  height: 600,
}

describe("attachment contracts", () => {
  it("exports constants, mime types, and core attachment schemas", () => {
    expect(imageAttachmentMimeTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ])
    expect(MAX_MESSAGE_ATTACHMENTS).toBe(6)
    expect(DESKTOP_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    expect(MOBILE_MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024)
    expect(MOBILE_THUMBNAIL_MAX_BYTES).toBe(40 * 1024)
    expect(ATTACHMENT_STAGING_TTL_MS).toBe(24 * 60 * 60 * 1000)

    expect(imageAttachmentSchema.parse(sampleAttachment)).toEqual(sampleAttachment)
    // Must reject local path leaks and non-image mime types
    expect(
      imageAttachmentSchema.safeParse({ ...sampleAttachment, path: "/tmp/a.png" }).success,
    ).toBe(false)
    expect(
      imageAttachmentSchema.safeParse({ ...sampleAttachment, mimeType: "image/svg+xml" }).success,
    ).toBe(false)

    expect(
      attachmentUploadParamsSchema.parse({
        dataBase64: "AQID",
        fileName: "a.png",
        mimeType: "image/png",
        threadId: "th_1",
      }),
    ).toEqual({
      dataBase64: "AQID",
      fileName: "a.png",
      mimeType: "image/png",
      threadId: "th_1",
    })
    expect(attachmentUploadResultSchema.parse({ attachment: sampleAttachment })).toEqual({
      attachment: sampleAttachment,
    })
    expect(attachmentReadParamsSchema.parse({ attachmentId: "att_1" })).toEqual({
      attachmentId: "att_1",
      variant: "full",
    })
    expect(
      attachmentReadResultSchema.parse({
        attachment: sampleAttachment,
        mimeType: "image/jpeg",
        dataBase64: "AQID",
      }),
    ).toMatchObject({ mimeType: "image/jpeg" })

    expect(
      attachmentThumbnailRequestSchema.parse({
        type: "attachment.thumbnail",
        id: "req_1",
        dataBase64: "AQID",
      }),
    ).toMatchObject({ maxEdge: 360, maxBytes: MOBILE_THUMBNAIL_MAX_BYTES })
    expect(
      attachmentThumbnailResultSchema.parse({
        type: "attachment.thumbnail.result",
        id: "req_1",
        dataBase64: null,
      }),
    ).toEqual({
      type: "attachment.thumbnail.result",
      id: "req_1",
      dataBase64: null,
    })
  })

  it("declares composer.attachments and validates mobile attachment RPC schemas", () => {
    expect(mobileFeatures).toContain("composer.attachments")
    expect(mobileAttachmentMethods).toEqual({
      uploadStart: "mobile.attachment.uploadStart",
      uploadChunk: "mobile.attachment.uploadChunk",
      uploadCancel: "mobile.attachment.uploadCancel",
      uploadFinish: "mobile.attachment.uploadFinish",
      read: "mobile.attachment.read",
    })

    const sha256 = "a".repeat(64)
    expect(
      mobileAttachmentUploadStartParams.parse({
        uploadId: "up_1",
        mimeType: "image/webp",
        fileName: "photo.webp",
        totalBytes: MOBILE_MAX_IMAGE_BYTES,
        sha256,
        width: 1200,
        height: 800,
      }),
    ).toMatchObject({ uploadId: "up_1", totalBytes: MOBILE_MAX_IMAGE_BYTES })
    expect(
      mobileAttachmentUploadStartParams.safeParse({
        uploadId: "up_1",
        mimeType: "image/webp",
        totalBytes: MOBILE_MAX_IMAGE_BYTES + 1,
        sha256,
      }).success,
    ).toBe(false)
    expect(
      mobileAttachmentUploadStartParams.safeParse({
        uploadId: "up_1",
        mimeType: "image/webp",
        totalBytes: 100,
        sha256: "not-hex",
      }).success,
    ).toBe(false)

    const exact32k = Buffer.alloc(32 * 1024, 1).toString("base64")
    const over32k = Buffer.alloc(32 * 1024 + 1, 1).toString("base64")
    expect(
      mobileAttachmentUploadChunkParams.parse({
        uploadId: "up_1",
        offset: 0,
        dataBase64: exact32k,
      }),
    ).toMatchObject({ uploadId: "up_1", offset: 0 })
    expect(
      mobileAttachmentUploadChunkParams.safeParse({
        uploadId: "up_1",
        offset: 0,
        dataBase64: over32k,
      }).success,
    ).toBe(false)

    expect(mobileAttachmentUploadCancelParams.parse({ uploadId: "up_1" })).toEqual({
      uploadId: "up_1",
    })
    expect(mobileAttachmentUploadFinishParams.parse({ uploadId: "up_1" })).toEqual({
      uploadId: "up_1",
    })
    expect(mobileAttachmentUploadFinishResult.parse({ attachment: sampleAttachment })).toEqual({
      attachment: sampleAttachment,
    })

    expect(
      mobileAttachmentReadParams.parse({
        threadId: "th_1",
        attachmentId: "att_1",
        variant: "thumb",
      }),
    ).toEqual({
      threadId: "th_1",
      attachmentId: "att_1",
      variant: "thumb",
    })
    expect(
      mobileAttachmentReadResult.parse({
        attachment: sampleAttachment,
        mimeType: "image/jpeg",
        dataBase64: "AQID",
        totalBytes: 3,
      }),
    ).toMatchObject({ totalBytes: 3 })

    expect(mobileAttachmentJsonSchemas()).toHaveProperty("MobileAttachmentUploadStartParams")
    expect(mobileAttachmentJsonSchemas()).toHaveProperty("MobileAttachmentReadResult")
  })

  it("registers desktop attachment RPCs and allows image-only run/draft requests", () => {
    expect(commandSchemas["attachment.upload"]).toBeDefined()
    expect(commandSchemas["attachment.read"]).toBeDefined()

    // Desktop run.start allows empty text when attachmentIds is non-empty, rejects both empty
    expect(
      commandSchemas["run.start"].parse({
        threadId: "th_1",
        text: "",
        attachmentIds: ["att_1"],
      }),
    ).toMatchObject({ text: "", attachmentIds: ["att_1"] })
    expect(commandSchemas["run.start"].safeParse({ threadId: "th_1", text: "" }).success).toBe(
      false,
    )
    expect(
      commandSchemas["run.start"].safeParse({
        threadId: "th_1",
        text: "",
        attachmentIds: [],
      }).success,
    ).toBe(false)
    expect(
      commandSchemas["run.start"].safeParse({
        threadId: "th_1",
        text: "hi",
        attachmentIds: ["1", "2", "3", "4", "5", "6", "7"],
      }).success,
    ).toBe(false)

    // Mobile run.start & thread.create allow empty text when attachmentIds is non-empty, keep legacy strict
    const commandId = "11111111-1111-4111-8111-111111111111"
    expect(
      mobileStartRunParams.parse({
        commandId,
        threadId: "th_1",
        text: "",
        attachmentIds: ["att_1"],
      }),
    ).toMatchObject({ text: "", attachmentIds: ["att_1"] })
    expect(
      mobileStartRunParams.safeParse({ commandId, threadId: "th_1", text: "   " }).success,
    ).toBe(false)
    expect(
      legacyMobileStartRunParams.safeParse({
        commandId,
        threadId: "th_1",
        text: "hi",
        attachmentIds: ["att_1"],
      }).success,
    ).toBe(false)

    expect(
      mobileDraftCreateParams.parse({
        commandId,
        projectId: "pr_1",
        instanceId: "fake",
        permissionMode: "full-access",
        text: "",
        attachmentIds: ["att_1"],
      }),
    ).toMatchObject({ text: "", attachmentIds: ["att_1"] })
    expect(
      mobileDraftCreateParams.safeParse({
        commandId,
        projectId: "pr_1",
        instanceId: "fake",
        permissionMode: "full-access",
        text: "   ",
      }).success,
    ).toBe(false)
    expect(
      legacyMobileDraftCreateParams.safeParse({
        commandId,
        projectId: "pr_1",
        instanceId: "fake",
        permissionMode: "full-access",
        text: "hi",
        attachmentIds: ["att_1"],
      }).success,
    ).toBe(false)

    // Timeline event & queue schemas accept optional attachments
    expect(
      mobileTimelineEvent.parse({
        seq: 1,
        kind: "message.user",
        createdAt: "2026-11-25T10:00:00.000Z",
        text: "",
        attachments: [sampleAttachment],
      }),
    ).toMatchObject({ attachments: [sampleAttachment] })

    expect(
      queuedMessagesSnapshot.parse({
        threadId: "th_1",
        paused: false,
        messages: [{ id: "qm_1", text: "", selected: false, attachments: [sampleAttachment] }],
      }),
    ).toMatchObject({ messages: [{ attachments: [sampleAttachment] }] })

    expect(
      queueReceipt.parse({
        commandId,
        threadId: "th_1",
        method: "queue.withdraw",
        effect: "withdrawn",
        messageId: "qm_1",
        text: "",
        attachments: [sampleAttachment],
      }),
    ).toMatchObject({ attachments: [sampleAttachment] })

    // JSON schemas still build cleanly
    expect(mobileCommandJsonSchemas()).toHaveProperty("MobileStartRunParams")
    expect(mobileDraftJsonSchemas()).toHaveProperty("MobileDraftCreateParams")
    expect(mobileTimelineJsonSchemas()).toHaveProperty("MobileTimelineEvent")
    expect(mobileQueueJsonSchemas()).toHaveProperty("QueueReceipt")
  })
})

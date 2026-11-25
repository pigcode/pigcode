import { describe, expect, it } from "vitest"
import {
  HOST_ERROR_CODES,
  MOBILE_PREVIEW_ALLOWED_METHODS,
  MOBILE_PREVIEW_CHUNK_BYTES,
  MOBILE_PREVIEW_INLINE_BODY_MAX,
  MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  commandSchemas,
  desktopPreviewUrlsMessageSchema,
  mobileFeatures,
  mobilePreviewCloseBodyParams,
  mobilePreviewCloseBodyResult,
  mobilePreviewFetchParams,
  mobilePreviewFetchResult,
  mobilePreviewJsonSchemas,
  mobilePreviewMethods,
  mobilePreviewReadBodyParams,
  mobilePreviewReadBodyResult,
  mobilePreviewSettingsSchema,
  mobilePreviewStatusParams,
  mobilePreviewStatusResult,
} from "./index"

describe("mobile preview.tunnel contracts", () => {
  it("declares preview.tunnel feature, error codes, constants, and RPC methods", () => {
    expect(mobileFeatures).toContain("preview.tunnel")
    expect(HOST_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "PREVIEW_DISABLED",
        "PREVIEW_URL_NOT_ALLOWED",
        "PREVIEW_UNREACHABLE",
        "PREVIEW_TIMEOUT",
        "PREVIEW_TOO_LARGE",
        "PREVIEW_STREAM_NOT_FOUND",
      ]),
    )
    expect(MOBILE_PREVIEW_INLINE_BODY_MAX).toBe(24 * 1024)
    expect(MOBILE_PREVIEW_CHUNK_BYTES).toBe(32 * 1024)
    expect(MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES).toBe(32 * 1024)
    expect(MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES).toBe(16 * 1024 * 1024)
    expect(MOBILE_PREVIEW_ALLOWED_METHODS).toEqual([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ])
    expect(mobilePreviewMethods).toEqual({
      status: "mobile.preview.status",
      fetch: "mobile.preview.fetch",
      readBody: "mobile.preview.readBody",
      closeBody: "mobile.preview.closeBody",
    })
    expect(commandSchemas["mobile.preview.getSettings"].parse({})).toEqual({})
    expect(commandSchemas["mobile.preview.setEnabled"].parse({ enabled: false })).toEqual({
      enabled: false,
    })
  })

  it("validates mobile preview schemas strictly", () => {
    expect(mobilePreviewStatusParams.parse({})).toEqual({})
    expect(mobilePreviewStatusParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobilePreviewStatusParams.safeParse({ extra: true }).success).toBe(false)

    expect(
      mobilePreviewStatusResult.parse({
        enabled: true,
        desktopUrls: ["http://localhost:5173/"],
      }),
    ).toEqual({
      enabled: true,
      desktopUrls: ["http://localhost:5173/"],
    })

    const maxBody = Buffer.alloc(MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES, 0x61).toString("base64")
    const overBody = Buffer.alloc(MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES + 1, 0x61).toString(
      "base64",
    )
    expect(
      mobilePreviewFetchParams.safeParse({
        requestId: "req-1",
        url: "http://localhost:3000/api",
        method: "POST",
        headers: { "content-type": "application/json" },
        bodyBase64: maxBody,
      }).success,
    ).toBe(true)
    expect(
      mobilePreviewFetchParams.safeParse({
        requestId: "req-2",
        url: "http://localhost:3000/api",
        method: "POST",
        bodyBase64: overBody,
      }).success,
    ).toBe(false)

    const tooManyHeaders: Record<string, string> = {}
    for (let i = 0; i < 65; i += 1) tooManyHeaders[`x-h-${i}`] = "1"
    expect(
      mobilePreviewFetchParams.safeParse({
        requestId: "req-3",
        url: "http://localhost:3000/",
        method: "GET",
        headers: tooManyHeaders,
      }).success,
    ).toBe(false)

    expect(
      mobilePreviewFetchResult.parse({
        status: 200,
        statusText: "OK",
        headers: [
          { name: "set-cookie", value: "a=1; Path=/" },
          { name: "set-cookie", value: "b=2; HttpOnly" },
        ],
        bodyBase64: Buffer.from("ok").toString("base64"),
        totalBytes: 2,
        hasMore: false,
      }).headers,
    ).toHaveLength(2)

    expect(
      mobilePreviewReadBodyParams.parse({
        bodyStreamId: "stream-1",
        offset: 0,
        length: 32768,
      }),
    ).toEqual({ bodyStreamId: "stream-1", offset: 0, length: 32768 })
    expect(
      mobilePreviewReadBodyParams.safeParse({
        bodyStreamId: "stream-1",
        offset: 0,
        length: 32769,
      }).success,
    ).toBe(false)

    expect(
      mobilePreviewReadBodyResult.parse({
        bodyStreamId: "stream-1",
        dataBase64: "YQ==",
        totalBytes: 1,
      }),
    ).toEqual({ bodyStreamId: "stream-1", dataBase64: "YQ==", totalBytes: 1 })

    expect(mobilePreviewCloseBodyParams.parse({ bodyStreamId: "stream-1" })).toEqual({
      bodyStreamId: "stream-1",
    })
    expect(mobilePreviewCloseBodyResult.parse({ ok: true })).toEqual({ ok: true })
    expect(
      mobilePreviewSettingsSchema.parse({ enabled: false, desktopUrls: [] }),
    ).toEqual({ enabled: false, desktopUrls: [] })
    expect(
      desktopPreviewUrlsMessageSchema.parse({
        type: "desktop.previewUrls",
        urls: ["http://127.0.0.1:4173/"],
      }),
    ).toEqual({
      type: "desktop.previewUrls",
      urls: ["http://127.0.0.1:4173/"],
    })
    expect(Object.keys(mobilePreviewJsonSchemas())).toContain("MobilePreviewFetchResult")
  })
})

/** 手机端加密本机预览隧道处理器：严格防 SSRF 校验、单帧内联或分片流式响应、断连与撤销即时清理。 */
import { randomUUID } from "node:crypto"
import {
  MOBILE_PREVIEW_CHUNK_BYTES,
  MOBILE_PREVIEW_INLINE_BODY_MAX,
  mobilePreviewCloseBodyParams,
  mobilePreviewCloseBodyResult,
  mobilePreviewFetchResult,
  mobilePreviewMethods as methods,
  mobilePreviewReadBodyParams,
  mobilePreviewReadBodyResult,
  mobilePreviewStatusParams,
  mobilePreviewStatusResult,
  type MobilePreviewCloseBodyParams,
  type MobilePreviewCloseBodyResult,
  type MobilePreviewFetchParams,
  type MobilePreviewFetchResult,
  type MobilePreviewReadBodyParams,
  type MobilePreviewReadBodyResult,
  type MobilePreviewStatusParams,
  type MobilePreviewStatusResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { MOBILE_PREVIEW_ENABLED_SETTING } from "../services/mobile-preview"
import { requireMobileThread } from "./command-receipts"
import {
  MAX_SAFE_FRAME_BYTES,
  assertDeclaredResponseLength,
  collectResponseHeaders,
  decodePreviewRequestBody,
  envelopeBytesForResult,
  isTimeoutError,
  parseFetchParams,
  readPreviewResponseBody,
  sanitizeRequestHeaders,
  validateMobilePreviewUrl,
} from "./preview-http"
import {
  armPreviewStreamTimer,
  assertDeviceStreamQuota,
  cleanupDeviceMobilePreviews,
  countDeviceInFlightFetches,
  disposeStreamEntry,
  getPreviewRegistry,
  previewRegistry,
  type ActiveFetchEntry,
  type PreviewStreamEntry,
} from "./preview-registry"
import { mobileParams, MobileRequestError } from "./request-error"

export { cleanupDeviceMobilePreviews, validateMobilePreviewUrl }

export const MOBILE_PREVIEW_FETCH_TIMEOUT_MS = 15_000
export const MOBILE_PREVIEW_STREAM_IDLE_TTL_MS = 30_000
export const MOBILE_PREVIEW_MAX_CONCURRENT_FETCHES = 16
export const MOBILE_PREVIEW_MAX_STREAMS_PER_DEVICE = 16
export const MOBILE_PREVIEW_MAX_STREAM_BYTES_PER_DEVICE = 32 * 1024 * 1024

export const mobilePreviewRequests: ReadonlySet<string> = new Set(Object.values(methods))

export type MobilePreviewFetchImpl = typeof globalThis.fetch

export interface MobilePreviewOptions {
  fetchImpl?: MobilePreviewFetchImpl
  timeoutMs?: number
  streamIdleTtlMs?: number
  maxConcurrentFetches?: number
  maxStreamsPerDevice?: number
  maxStreamBytesPerDevice?: number
}

export class MobilePreview {
  private readonly ownedInFlight = new Set<ActiveFetchEntry>()
  private readonly ownedStreams = new Set<string>()
  private readonly fetchImpl: MobilePreviewFetchImpl
  private readonly timeoutMs: number
  private readonly streamIdleTtlMs: number
  private readonly maxConcurrentFetches: number
  private readonly maxStreamsPerDevice: number
  private readonly maxStreamBytesPerDevice: number
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly deviceKey: string,
    private readonly requirePairedDevice: () => void,
    options: MobilePreviewOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? MOBILE_PREVIEW_FETCH_TIMEOUT_MS
    this.streamIdleTtlMs = options.streamIdleTtlMs ?? MOBILE_PREVIEW_STREAM_IDLE_TTL_MS
    this.maxConcurrentFetches =
      options.maxConcurrentFetches ?? MOBILE_PREVIEW_MAX_CONCURRENT_FETCHES
    this.maxStreamsPerDevice = options.maxStreamsPerDevice ?? MOBILE_PREVIEW_MAX_STREAMS_PER_DEVICE
    this.maxStreamBytesPerDevice =
      options.maxStreamBytesPerDevice ?? MOBILE_PREVIEW_MAX_STREAM_BYTES_PER_DEVICE
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.status:
        return this.status(mobileParams(mobilePreviewStatusParams, request.params))
      case methods.fetch:
        return this.fetch(parseFetchParams(request.params))
      case methods.readBody:
        return this.readBody(mobileParams(mobilePreviewReadBodyParams, request.params))
      case methods.closeBody:
        return this.closeBody(mobileParams(mobilePreviewCloseBodyParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  /** 连接断开时立即中止本连接所有在途请求并释放其占用的预览数据流。 */
  close(): void {
    this.closed = true
    const registry = getPreviewRegistry(this.ctx)
    for (const active of [...this.ownedInFlight]) {
      active.abortedByLifecycle = true
      registry?.inFlight.delete(active)
      active.controller.abort()
    }
    this.ownedInFlight.clear()

    if (registry) {
      for (const streamId of [...this.ownedStreams]) {
        const entry = registry.streams.get(streamId)
        if (entry?.owner === this) {
          clearTimeout(entry.timer)
          registry.streams.delete(streamId)
        }
      }
    }
    this.ownedStreams.clear()
  }

  /** 仅供撤销配对清理同步移除本地引用。 */
  forgetInFlight(entry: ActiveFetchEntry): void {
    this.ownedInFlight.delete(entry)
  }

  /** 仅供撤销配对或过期清理同步移除本地流引用。 */
  forgetStream(streamId: string): void {
    this.ownedStreams.delete(streamId)
  }

  private isPreviewEnabled(): boolean {
    const service = this.ctx.get("mobilePreview")
    if (service) return service.isEnabled()
    return this.ctx.settings.get(MOBILE_PREVIEW_ENABLED_SETTING) !== false
  }

  private desktopUrls(): string[] {
    return this.ctx.get("mobilePreview")?.desktopUrls() ?? []
  }

  private status(params: MobilePreviewStatusParams): MobilePreviewStatusResult {
    if (params.threadId !== undefined) {
      requireMobileThread(this.ctx, params.threadId)
    }
    return mobilePreviewStatusResult.parse({
      enabled: this.isPreviewEnabled(),
      desktopUrls: this.desktopUrls(),
    })
  }

  private async fetch(params: MobilePreviewFetchParams): Promise<MobilePreviewFetchResult> {
    if (!this.isPreviewEnabled()) {
      throw new MobileRequestError("PREVIEW_DISABLED")
    }

    if ((params.method === "GET" || params.method === "HEAD") && params.bodyBase64) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    const targetUrl = validateMobilePreviewUrl(params.url)
    const requestHeaders = sanitizeRequestHeaders(params.headers, targetUrl.host)
    const requestBody = decodePreviewRequestBody(params)

    const registry = previewRegistry(this.ctx)
    if (countDeviceInFlightFetches(registry, this.deviceKey) >= this.maxConcurrentFetches) {
      throw new MobileRequestError("PREVIEW_TOO_LARGE")
    }

    const controller = new AbortController()
    const entry: ActiveFetchEntry = {
      ownerDeviceKey: this.deviceKey,
      owner: this,
      controller,
      abortedByLifecycle: false,
    }
    registry.inFlight.add(entry)
    this.ownedInFlight.add(entry)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    timer.unref?.()

    try {
      const init: RequestInit = {
        method: params.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: controller.signal,
        ...(requestBody !== undefined ? { body: requestBody as unknown as BodyInit } : {}),
      }

      let response: Response
      try {
        response = await this.fetchImpl(targetUrl.toString(), init)
      } catch (error) {
        if (entry.abortedByLifecycle) {
          this.requirePairedDevice()
          throw new MobileRequestError("PREVIEW_STREAM_NOT_FOUND")
        }
        if (timedOut || isTimeoutError(error)) {
          throw new MobileRequestError("PREVIEW_TIMEOUT")
        }
        throw new MobileRequestError("PREVIEW_UNREACHABLE")
      }

      assertDeclaredResponseLength(response.headers, controller)
      const responseHeaders = collectResponseHeaders(response.headers)
      const bodyBuffer = await readPreviewResponseBody({
        method: params.method,
        response,
        controller,
        isAbortedByLifecycle: () => entry.abortedByLifecycle,
        isTimedOut: () => timedOut,
        requirePairedDevice: () => this.requirePairedDevice(),
      })

      // 异步完成后重新确认连接、配对与预览开关状态。
      if (this.closed || entry.abortedByLifecycle) {
        this.requirePairedDevice()
        throw new MobileRequestError("PREVIEW_STREAM_NOT_FOUND")
      }
      this.requirePairedDevice()
      if (!this.isPreviewEnabled()) {
        throw new MobileRequestError("PREVIEW_DISABLED")
      }

      const status = response.status
      const statusText = response.statusText.slice(0, 256)
      const totalBytes = bodyBuffer.length

      if (totalBytes <= MOBILE_PREVIEW_INLINE_BODY_MAX) {
        const inlineResult: MobilePreviewFetchResult = {
          status,
          statusText,
          headers: responseHeaders,
          bodyBase64: bodyBuffer.toString("base64"),
          totalBytes,
          hasMore: false,
        }
        if (envelopeBytesForResult(inlineResult) <= MAX_SAFE_FRAME_BYTES) {
          return mobilePreviewFetchResult.parse(inlineResult)
        }
      }

      const streamId = randomUUID()
      const streamResult: MobilePreviewFetchResult = {
        status,
        statusText,
        headers: responseHeaders,
        bodyStreamId: streamId,
        totalBytes,
        hasMore: true,
      }
      if (envelopeBytesForResult(streamResult) > MAX_SAFE_FRAME_BYTES) {
        throw new MobileRequestError("PREVIEW_TOO_LARGE")
      }

      this.registerStream(streamId, bodyBuffer)
      return mobilePreviewFetchResult.parse(streamResult)
    } finally {
      clearTimeout(timer)
      registry.inFlight.delete(entry)
      this.ownedInFlight.delete(entry)
    }
  }

  private registerStream(streamId: string, buffer: Buffer): void {
    const registry = previewRegistry(this.ctx)
    assertDeviceStreamQuota(
      registry,
      this.deviceKey,
      buffer.length,
      this.maxStreamsPerDevice,
      this.maxStreamBytesPerDevice,
    )

    const timer = armPreviewStreamTimer(this.ctx, streamId, this.streamIdleTtlMs)
    const streamEntry: PreviewStreamEntry = {
      streamId,
      ownerDeviceKey: this.deviceKey,
      owner: this,
      buffer,
      totalBytes: buffer.length,
      timer,
    }
    registry.streams.set(streamId, streamEntry)
    this.ownedStreams.add(streamId)
  }

  private readBody(params: MobilePreviewReadBodyParams): MobilePreviewReadBodyResult {
    const registry = previewRegistry(this.ctx)
    const entry = registry.streams.get(params.bodyStreamId)
    if (!this.isPreviewEnabled()) {
      if (entry && entry.ownerDeviceKey === this.deviceKey) {
        disposeStreamEntry(registry, entry)
      }
      throw new MobileRequestError("PREVIEW_DISABLED")
    }
    if (!entry || entry.ownerDeviceKey !== this.deviceKey) {
      throw new MobileRequestError("PREVIEW_STREAM_NOT_FOUND")
    }

    const { offset, length } = params
    if (entry.totalBytes === 0 ? offset !== 0 : offset >= entry.totalBytes) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    const chunkLen = Math.min(length ?? MOBILE_PREVIEW_CHUNK_BYTES, MOBILE_PREVIEW_CHUNK_BYTES)
    const end = Math.min(offset + chunkLen, entry.totalBytes)
    const slice = entry.buffer.subarray(offset, end)
    const nextOffset = end < entry.totalBytes ? end : undefined

    if (nextOffset === undefined) {
      disposeStreamEntry(registry, entry)
    } else {
      clearTimeout(entry.timer)
      entry.timer = armPreviewStreamTimer(this.ctx, entry.streamId, this.streamIdleTtlMs)
    }

    return mobilePreviewReadBodyResult.parse({
      bodyStreamId: params.bodyStreamId,
      dataBase64: slice.toString("base64"),
      totalBytes: entry.totalBytes,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    })
  }

  private closeBody(params: MobilePreviewCloseBodyParams): MobilePreviewCloseBodyResult {
    const registry = previewRegistry(this.ctx)
    const entry = registry.streams.get(params.bodyStreamId)
    if (entry) {
      if (entry.ownerDeviceKey !== this.deviceKey) {
        throw new MobileRequestError("PREVIEW_STREAM_NOT_FOUND")
      }
      disposeStreamEntry(registry, entry)
    }
    return mobilePreviewCloseBodyResult.parse({ ok: true })
  }
}

/** 手机端加密本机预览隧道处理器：严格防 SSRF 校验、单帧内联或分片流式响应、断连与撤销即时清理。 */
import { randomUUID } from "node:crypto"
import {
  MOBILE_PREVIEW_CHUNK_BYTES,
  MOBILE_PREVIEW_INLINE_BODY_MAX,
  MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  mobilePreviewCloseBodyParams,
  mobilePreviewCloseBodyResult,
  mobilePreviewFetchParams,
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
  type MobilePreviewHeader,
  type MobilePreviewReadBodyParams,
  type MobilePreviewReadBodyResult,
  type MobilePreviewStatusParams,
  type MobilePreviewStatusResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import {
  MOBILE_PREVIEW_ENABLED_SETTING,
  parseAllowedMobilePreviewUrl,
} from "../services/mobile-preview"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

export const MOBILE_PREVIEW_FETCH_TIMEOUT_MS = 15_000
export const MOBILE_PREVIEW_STREAM_IDLE_TTL_MS = 30_000
export const MOBILE_PREVIEW_MAX_CONCURRENT_FETCHES = 16
export const MOBILE_PREVIEW_MAX_STREAMS_PER_DEVICE = 16
export const MOBILE_PREVIEW_MAX_STREAM_BYTES_PER_DEVICE = 32 * 1024 * 1024

/** 单帧 JSON-RPC 响应的安全字节上限（严格低于 Noise 65,519 字节明文上限）。 */
const MAX_SAFE_FRAME_BYTES = 60 * 1024

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

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

interface ActiveFetchEntry {
  ownerDeviceKey: string
  owner: MobilePreview
  controller: AbortController
  abortedByLifecycle: boolean
}

interface PreviewStreamEntry {
  streamId: string
  ownerDeviceKey: string
  owner: MobilePreview
  buffer: Buffer
  totalBytes: number
  timer: ReturnType<typeof setTimeout>
}

interface PreviewRegistry {
  inFlight: Set<ActiveFetchEntry>
  streams: Map<string, PreviewStreamEntry>
}

const registryByContext = new WeakMap<Context, PreviewRegistry>()

function previewRegistry(ctx: Context): PreviewRegistry {
  let registry = registryByContext.get(ctx)
  if (!registry) {
    registry = {
      inFlight: new Set(),
      streams: new Map(),
    }
    registryByContext.set(ctx, registry)
  }
  return registry
}

function isHopByHopHeader(lowerName: string, connectionTokens?: ReadonlySet<string>): boolean {
  return (
    HOP_BY_HOP_HEADERS.has(lowerName) ||
    lowerName.startsWith("proxy-") ||
    (connectionTokens !== undefined && connectionTokens.has(lowerName))
  )
}

function connectionHeaderTokens(values: Iterable<string>): Set<string> {
  const tokens = new Set<string>()
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const token = part.trim().toLowerCase()
      if (token) tokens.add(token)
    }
  }
  return tokens
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

/** 严格校验允许通过手机端预览隧道访问的本机 loopback URL，非法直接抛 `PREVIEW_URL_NOT_ALLOWED`。 */
export function validateMobilePreviewUrl(rawUrl: string): URL {
  const parsed = parseAllowedMobilePreviewUrl(rawUrl)
  if (!parsed) throw new MobileRequestError("PREVIEW_URL_NOT_ALLOWED")
  return parsed
}

function parseFetchParams(input: unknown): MobilePreviewFetchParams {
  const value = input === undefined ? {} : input
  const parsed = mobilePreviewFetchParams.safeParse(value)
  if (parsed.success) return parsed.data

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (
      typeof record.bodyBase64 === "string" &&
      record.bodyBase64.length > 0 &&
      record.bodyBase64.length % 4 === 0 &&
      BASE64_PATTERN.test(record.bodyBase64) &&
      decodedBase64Bytes(record.bodyBase64) > MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES &&
      mobilePreviewFetchParams.safeParse({ ...record, bodyBase64: "" }).success
    ) {
      throw new MobileRequestError("PREVIEW_TOO_LARGE")
    }
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

function sanitizeRequestHeaders(
  input: Record<string, string> | undefined,
  targetHost: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (input) {
    const connectionValues: string[] = []
    for (const [name, value] of Object.entries(input)) {
      if (!HEADER_NAME_PATTERN.test(name) || HEADER_VALUE_FORBIDDEN.test(value)) {
        throw new MobileRequestError("INVALID_PARAMS")
      }
      if (name.toLowerCase() === "connection") connectionValues.push(value)
    }
    const extraHopByHop = connectionHeaderTokens(connectionValues)
    for (const [name, value] of Object.entries(input)) {
      const lower = name.toLowerCase()
      if (
        isHopByHopHeader(lower, extraHopByHop) ||
        lower === "host" ||
        lower === "content-length" ||
        lower === "accept-encoding"
      ) {
        continue
      }
      result[name] = value
    }
  }
  result["host"] = targetHost
  result["accept-encoding"] = "identity"
  return result
}

function collectResponseHeaders(headers: Headers): MobilePreviewHeader[] {
  const connectionValues: string[] = []
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "connection") connectionValues.push(value)
  }
  const extraHopByHop = connectionHeaderTokens(connectionValues)
  const collected: MobilePreviewHeader[] = []

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase()
    if (
      lower === "set-cookie" ||
      lower === "content-encoding" ||
      lower === "content-length" ||
      isHopByHopHeader(lower, extraHopByHop)
    ) {
      continue
    }
    if (name.length > 256 || value.length > 8192) {
      throw new MobileRequestError("PREVIEW_TOO_LARGE")
    }
    collected.push({ name, value })
  }

  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.has("set-cookie")
        ? [headers.get("set-cookie")!]
        : []
  for (const cookie of setCookies) {
    if (cookie.length > 8192) throw new MobileRequestError("PREVIEW_TOO_LARGE")
    collected.push({ name: "set-cookie", value: cookie })
  }
  return collected
}

function envelopeBytesForResult(result: unknown): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "x".repeat(128),
      result,
    }),
  )
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const name = "name" in error ? (error as { name?: unknown }).name : undefined
  const code = "code" in error ? (error as { code?: unknown }).code : undefined
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true
  }
  if ("cause" in error && (error as { cause?: unknown }).cause !== undefined) {
    return isTimeoutError((error as { cause?: unknown }).cause)
  }
  return false
}

function disposeStreamEntry(registry: PreviewRegistry, entry: PreviewStreamEntry): void {
  clearTimeout(entry.timer)
  registry.streams.delete(entry.streamId)
  entry.owner.forgetStream(entry.streamId)
}

/** 撤销设备配对时，立即中止该设备所有在途预览请求并清空该设备全部预览响应流。 */
export function cleanupDeviceMobilePreviews(ctx: Context, deviceKey: string): void {
  const registry = registryByContext.get(ctx)
  if (!registry) return

  for (const active of [...registry.inFlight]) {
    if (active.ownerDeviceKey !== deviceKey) continue
    active.abortedByLifecycle = true
    registry.inFlight.delete(active)
    active.owner.forgetInFlight(active)
    active.controller.abort()
  }

  for (const entry of [...registry.streams.values()]) {
    if (entry.ownerDeviceKey !== deviceKey) continue
    disposeStreamEntry(registry, entry)
  }
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
    this.maxStreamsPerDevice =
      options.maxStreamsPerDevice ?? MOBILE_PREVIEW_MAX_STREAMS_PER_DEVICE
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
    const registry = registryByContext.get(this.ctx)
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

    let requestBody: Uint8Array | undefined
    if (params.bodyBase64 !== undefined && params.method !== "GET" && params.method !== "HEAD") {
      const decoded = Buffer.from(params.bodyBase64, "base64")
      if (decoded.length > MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES) {
        throw new MobileRequestError("PREVIEW_TOO_LARGE")
      }
      requestBody = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)
    }

    const registry = previewRegistry(this.ctx)
    let activeForDevice = 0
    for (const active of registry.inFlight) {
      if (active.ownerDeviceKey === this.deviceKey) activeForDevice += 1
    }
    if (activeForDevice >= this.maxConcurrentFetches) {
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

      const contentEncoding = response.headers.get("content-encoding")
      const contentLengthHeader = response.headers.get("content-length")
      if (!contentEncoding && contentLengthHeader !== null) {
        const declared = Number(contentLengthHeader)
        if (Number.isFinite(declared) && declared > MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES) {
          controller.abort()
          throw new MobileRequestError("PREVIEW_TOO_LARGE")
        }
      }

      const responseHeaders = collectResponseHeaders(response.headers)
      const bodyBuffer = await this.readResponseBody(
        params.method,
        response,
        controller,
        entry,
        () => timedOut,
      )

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

  private async readResponseBody(
    method: string,
    response: Response,
    controller: AbortController,
    entry: ActiveFetchEntry,
    isTimedOut: () => boolean,
  ): Promise<Buffer> {
    if (method === "HEAD" || response.status === 204 || response.status === 304 || !response.body) {
      return Buffer.alloc(0)
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        total += value.byteLength
        if (total > MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES) {
          await reader.cancel().catch(() => {})
          controller.abort()
          throw new MobileRequestError("PREVIEW_TOO_LARGE")
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      }
    } catch (error) {
      if (error instanceof MobileRequestError) throw error
      if (entry.abortedByLifecycle) {
        this.requirePairedDevice()
        throw new MobileRequestError("PREVIEW_STREAM_NOT_FOUND")
      }
      if (isTimedOut() || isTimeoutError(error)) {
        throw new MobileRequestError("PREVIEW_TIMEOUT")
      }
      throw new MobileRequestError("PREVIEW_UNREACHABLE")
    } finally {
      reader.releaseLock()
    }
    return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total)
  }

  private registerStream(streamId: string, buffer: Buffer): void {
    const registry = previewRegistry(this.ctx)
    let deviceStreamCount = 0
    let deviceStreamBytes = 0
    for (const existing of registry.streams.values()) {
      if (existing.ownerDeviceKey !== this.deviceKey) continue
      deviceStreamCount += 1
      deviceStreamBytes += existing.totalBytes
    }
    if (
      deviceStreamCount >= this.maxStreamsPerDevice ||
      deviceStreamBytes + buffer.length > this.maxStreamBytesPerDevice
    ) {
      throw new MobileRequestError("PREVIEW_TOO_LARGE")
    }

    const timer = this.armStreamTimer(streamId)
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

  private armStreamTimer(streamId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const registry = registryByContext.get(this.ctx)
      const entry = registry?.streams.get(streamId)
      if (registry && entry) disposeStreamEntry(registry, entry)
    }, this.streamIdleTtlMs)
    timer.unref?.()
    return timer
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
      entry.timer = this.armStreamTimer(entry.streamId)
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

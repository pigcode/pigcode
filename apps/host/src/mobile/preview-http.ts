/** 手机端本机预览隧道的纯 HTTP/URL 校验、头字段清洗、请求体解码与流式响应读取辅助函数。 */
import {
  MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  mobilePreviewFetchParams,
  type MobilePreviewFetchParams,
  type MobilePreviewHeader,
} from "@pigcode/contracts"
import { parseAllowedMobilePreviewUrl } from "../services/mobile-preview"
import { MobileRequestError } from "./request-error"

/** 单帧 JSON-RPC 响应的安全字节上限（严格低于 Noise 65,519 字节明文上限）。 */
export const MAX_SAFE_FRAME_BYTES = 60 * 1024

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

export function parseFetchParams(input: unknown): MobilePreviewFetchParams {
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

export function decodePreviewRequestBody(params: MobilePreviewFetchParams): Uint8Array | undefined {
  if (params.bodyBase64 === undefined || params.method === "GET" || params.method === "HEAD") {
    return undefined
  }
  const decoded = Buffer.from(params.bodyBase64, "base64")
  if (decoded.length > MOBILE_PREVIEW_MAX_REQUEST_BODY_BYTES) {
    throw new MobileRequestError("PREVIEW_TOO_LARGE")
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)
}

export function sanitizeRequestHeaders(
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

export function collectResponseHeaders(headers: Headers): MobilePreviewHeader[] {
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

export function assertDeclaredResponseLength(headers: Headers, controller: AbortController): void {
  const contentEncoding = headers.get("content-encoding")
  const contentLengthHeader = headers.get("content-length")
  if (!contentEncoding && contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader)
    if (Number.isFinite(declared) && declared > MOBILE_PREVIEW_MAX_RESPONSE_BODY_BYTES) {
      controller.abort()
      throw new MobileRequestError("PREVIEW_TOO_LARGE")
    }
  }
}

export function envelopeBytesForResult(result: unknown): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "x".repeat(128),
      result,
    }),
  )
}

export function isTimeoutError(error: unknown): boolean {
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

export async function readPreviewResponseBody(options: {
  method: string
  response: Response
  controller: AbortController
  isAbortedByLifecycle: () => boolean
  isTimedOut: () => boolean
  requirePairedDevice: () => void
}): Promise<Buffer> {
  const { method, response, controller, isAbortedByLifecycle, isTimedOut, requirePairedDevice } =
    options
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
    if (isAbortedByLifecycle()) {
      requirePairedDevice()
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

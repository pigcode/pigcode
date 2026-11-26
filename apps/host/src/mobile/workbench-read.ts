/** 手机端工作台文件分片阅读器：文本、图片（含缩略图 LRU 缓存）与二进制探测。 */
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  MOBILE_WORKBENCH_TEXT_CHUNK_MAX,
  mobileWorkspaceReadFileResult,
  type ImageAttachmentMimeType,
  type MobileWorkspaceReadFileParams,
  type MobileWorkspaceReadFileResult,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { inspectImageBuffer, type InspectedImage } from "../services/image-inspect"
import { resolveInside, resolveRealInside } from "../services/path-safety"
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, toPosix } from "../services/workspace-files"
import { requireMobileThread } from "./command-receipts"
import { MobileRequestError } from "./request-error"
import {
  detectLanguageHint,
  isHighSurrogate,
  isLowSurrogate,
  mapWorkspaceError,
  normalizeRelativePath,
  readHead,
  requireWorkspace,
  trimIncompleteUtf8Tail,
} from "./workbench-helpers"

/** 二进制探测检查文件头部的最大字节数（与 workspace-files.ts 保持一致）。 */
const BINARY_SNIFF_BYTES = 8 * 1024
/** 图像魔数初步探测读取的文件头大小。 */
const IMAGE_SNIFF_BYTES = 64 * 1024
/** 单帧 JSON-RPC 响应的安全上限，远低于 Noise 65,519 字节明文上限。 */
const MAX_SAFE_IMAGE_RESPONSE_BYTES = 60 * 1024
/** 进程内工作区缩略图 LRU 容量，确保同一文件跨分片读取一致。 */
const THUMB_CACHE_LIMIT = 16

interface CachedThumb {
  mimeType: ImageAttachmentMimeType
  buffer: Buffer
  width?: number
  height?: number
}

export class MobileWorkbenchFileReader {
  private readonly thumbCache = new Map<string, CachedThumb>()

  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
    private readonly frameByteBudget: number,
  ) {}

  async readFile(params: MobileWorkspaceReadFileParams): Promise<MobileWorkspaceReadFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
    const cleanInput = normalizeRelativePath(params.path, { allowEmpty: false })
    const root = workspace.root(params.threadId)

    let target: string
    let canonicalPath: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      const lexical = resolveInside(root, cleanInput)
      target = await resolveRealInside(root, cleanInput)
      info = await stat(target)
      if (!info.isFile()) throw new MobileRequestError("INVALID_PARAMS")
      canonicalPath = toPosix(relative(resolve(root), lexical))
      if (!canonicalPath || canonicalPath.startsWith("..") || isAbsolute(canonicalPath)) {
        throw new MobileRequestError("INVALID_PARAMS")
      }
    } catch (error) {
      mapWorkspaceError(error)
    }

    const requestedMode = params.mode ?? "auto"
    const variant = params.variant ?? "full"

    if (requestedMode === "image") {
      if (info.size > MAX_IMAGE_BYTES) {
        throw new MobileRequestError("ATTACHMENT_TOO_LARGE")
      }
      let original: Buffer
      try {
        original = await readFile(target)
      } catch (error) {
        mapWorkspaceError(error)
      }
      const inspected = inspectImageBuffer(original)
      if (!inspected) {
        throw new MobileRequestError("ATTACHMENT_UNSUPPORTED_TYPE")
      }
      return this.buildImageResult(
        params,
        canonicalPath,
        target,
        info,
        original,
        inspected,
        variant,
      )
    }

    if (requestedMode === "auto" && info.size > 0) {
      let head: Buffer
      try {
        head = await readHead(target, Math.min(info.size, IMAGE_SNIFF_BYTES))
      } catch (error) {
        mapWorkspaceError(error)
      }
      let inspected = inspectImageBuffer(head)
      let fullBytes: Buffer | undefined
      const looksLikeJpeg =
        !inspected &&
        head.length >= 3 &&
        head[0] === 0xff &&
        head[1] === 0xd8 &&
        head[2] === 0xff &&
        info.size > head.length &&
        info.size <= MAX_IMAGE_BYTES
      if (looksLikeJpeg) {
        try {
          fullBytes = await readFile(target)
        } catch (error) {
          mapWorkspaceError(error)
        }
        inspected = inspectImageBuffer(fullBytes)
      }
      if (inspected) {
        if (info.size > MAX_IMAGE_BYTES) {
          throw new MobileRequestError("ATTACHMENT_TOO_LARGE")
        }
        let original = fullBytes
        if (!original) {
          if (info.size === head.length) {
            original = head
          } else {
            try {
              original = await readFile(target)
            } catch (error) {
              mapWorkspaceError(error)
            }
          }
        }
        return this.buildImageResult(
          params,
          canonicalPath,
          target,
          info,
          original,
          inspected,
          variant,
        )
      }
    }

    return this.buildTextOrBinaryResult(params, canonicalPath, target, info)
  }

  private async buildImageResult(
    params: MobileWorkspaceReadFileParams,
    canonicalPath: string,
    realTarget: string,
    info: { size: number; mtimeMs: number },
    original: Buffer,
    inspected: InspectedImage,
    variant: "thumb" | "full",
  ): Promise<MobileWorkspaceReadFileResult> {
    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    let payload = original
    let mimeType: ImageAttachmentMimeType = inspected.mimeType
    let width = inspected.width
    let height = inspected.height

    if (variant === "thumb" && original.length > MOBILE_THUMBNAIL_MAX_BYTES) {
      const cacheKey = `${realTarget}\0${info.mtimeMs}\0${info.size}`
      const cached = this.thumbCache.get(cacheKey)
      if (cached) {
        payload = cached.buffer
        mimeType = cached.mimeType
        width = cached.width
        height = cached.height
      } else {
        const generated = await this.ctx.get("attachments")?.generateThumbnail(original, {
          maxBytes: MOBILE_ATTACHMENT_CHUNK_BYTES,
        })
        this.requirePairedDevice()
        requireMobileThread(this.ctx, params.threadId)
        if (generated && generated.length > 0) {
          const thumbInspected = inspectImageBuffer(generated)
          payload = generated
          mimeType = thumbInspected?.mimeType ?? "image/jpeg"
          width = thumbInspected?.width ?? inspected.width
          height = thumbInspected?.height ?? inspected.height
          this.rememberThumb(cacheKey, {
            mimeType,
            buffer: payload,
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
          })
        }
      }
    }

    const totalSize = payload.length
    const offset = params.offset ?? 0
    if (totalSize === 0 ? offset !== 0 : offset >= totalSize) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "x".repeat(128),
        result: {
          path: canonicalPath,
          mode: "image",
          totalSize,
          binary: true,
          truncated: true,
          mimeType,
          dataBase64: "",
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          nextOffset: totalSize,
          mtimeMs: info.mtimeMs,
        },
      }),
    )
    const maxRawByFrame = Math.max(
      1024,
      Math.floor((MAX_SAFE_IMAGE_RESPONSE_BYTES - envelopeBytes) / 4) * 3,
    )
    const chunkLen = Math.min(
      params.length ?? MOBILE_ATTACHMENT_CHUNK_BYTES,
      MOBILE_ATTACHMENT_CHUNK_BYTES,
      maxRawByFrame,
    )

    const end = Math.min(offset + chunkLen, totalSize)
    const slice = payload.subarray(offset, end)
    const nextOffset = end < totalSize ? end : undefined

    return mobileWorkspaceReadFileResult.parse({
      path: canonicalPath,
      mode: "image",
      totalSize,
      binary: true,
      truncated: nextOffset !== undefined,
      mimeType,
      dataBase64: slice.toString("base64"),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      mtimeMs: info.mtimeMs,
    })
  }

  private rememberThumb(key: string, value: CachedThumb): void {
    if (this.thumbCache.size >= THUMB_CACHE_LIMIT) {
      const oldest = this.thumbCache.keys().next().value
      if (oldest !== undefined) this.thumbCache.delete(oldest)
    }
    this.thumbCache.set(key, value)
  }

  private async buildTextOrBinaryResult(
    params: MobileWorkspaceReadFileParams,
    canonicalPath: string,
    realTarget: string,
    info: { size: number; mtimeMs: number },
  ): Promise<MobileWorkspaceReadFileResult> {
    let rawBytes: Buffer
    try {
      rawBytes = await readHead(realTarget, Math.min(info.size, MAX_TEXT_BYTES))
    } catch (error) {
      mapWorkspaceError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    const binary = rawBytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    if (binary) {
      return mobileWorkspaceReadFileResult.parse({
        path: canonicalPath,
        mode: "binary",
        totalSize: info.size,
        binary: true,
        truncated: false,
        mtimeMs: info.mtimeMs,
      })
    }

    const fileExceededCap = info.size > MAX_TEXT_BYTES
    const textBytes = fileExceededCap ? trimIncompleteUtf8Tail(rawBytes) : rawBytes
    const fullText = textBytes.toString("utf8")
    const eol: "lf" | "crlf" = fullText.includes("\r\n") ? "crlf" : "lf"
    const languageHint = detectLanguageHint(canonicalPath)
    const offset = params.offset ?? 0

    if (fullText.length === 0) {
      if (offset !== 0) throw new MobileRequestError("INVALID_PARAMS")
      return mobileWorkspaceReadFileResult.parse({
        path: canonicalPath,
        mode: "text",
        totalSize: info.size,
        binary: false,
        truncated: fileExceededCap,
        text: "",
        eol,
        ...(languageHint ? { languageHint } : {}),
        mtimeMs: info.mtimeMs,
      })
    }

    if (offset >= fullText.length || isLowSurrogate(fullText.charCodeAt(offset))) {
      throw new MobileRequestError("INVALID_PARAMS")
    }

    const maxChars = Math.min(
      params.length ?? MOBILE_WORKBENCH_TEXT_CHUNK_MAX,
      MOBILE_WORKBENCH_TEXT_CHUNK_MAX,
    )
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        path: canonicalPath,
        mode: "text",
        totalSize: info.size,
        binary: false,
        truncated: true,
        text: "",
        eol,
        ...(languageHint ? { languageHint } : {}),
        nextOffset: fullText.length,
        mtimeMs: info.mtimeMs,
      }),
    )
    const maxTextJsonBytes = Math.max(1024, this.frameByteBudget - envelopeBytes)

    let end = Math.min(offset + maxChars, fullText.length)
    if (end < fullText.length && isLowSurrogate(fullText.charCodeAt(end))) {
      end -= 1
    }
    if (end <= offset) {
      end =
        offset +
        (isHighSurrogate(fullText.charCodeAt(offset)) &&
        offset + 1 < fullText.length &&
        isLowSurrogate(fullText.charCodeAt(offset + 1))
          ? 2
          : 1)
    }

    if (Buffer.byteLength(JSON.stringify(fullText.slice(offset, end))) > maxTextJsonBytes) {
      let lo = offset + 1
      let hi = end
      let best = offset + 1
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        if (Buffer.byteLength(JSON.stringify(fullText.slice(offset, mid))) <= maxTextJsonBytes) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      end = best
      if (end < fullText.length && isLowSurrogate(fullText.charCodeAt(end))) {
        end -= 1
      }
      if (end <= offset) {
        end =
          offset +
          (isHighSurrogate(fullText.charCodeAt(offset)) &&
          offset + 1 < fullText.length &&
          isLowSurrogate(fullText.charCodeAt(offset + 1))
            ? 2
            : 1)
      }
    }

    const nextOffset = end < fullText.length ? end : undefined
    const truncated = nextOffset !== undefined || fileExceededCap

    return mobileWorkspaceReadFileResult.parse({
      path: canonicalPath,
      mode: "text",
      totalSize: info.size,
      binary: false,
      truncated,
      text: fullText.slice(offset, end),
      eol,
      ...(languageHint ? { languageHint } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      mtimeMs: info.mtimeMs,
    })
  }
}

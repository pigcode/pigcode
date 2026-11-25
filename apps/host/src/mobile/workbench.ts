/** 手机端只读工作台处理器：目录分页浏览、文本/图片分片阅读、代码搜索与 PR 状态查询。 */
import { open, readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve } from "node:path"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  MOBILE_WORKBENCH_FRAME_BYTES,
  MOBILE_WORKBENCH_LIST_DEFAULT_LIMIT,
  MOBILE_WORKBENCH_PATH_MAX,
  MOBILE_WORKBENCH_SEARCH_DEFAULT_LIMIT,
  MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX,
  MOBILE_WORKBENCH_TEXT_CHUNK_MAX,
  mobilePrStatusParams,
  mobilePrStatusResult,
  mobileWorkbenchMethods as methods,
  mobileWorkspaceListParams,
  mobileWorkspaceListResult,
  mobileWorkspaceReadFileParams,
  mobileWorkspaceReadFileResult,
  mobileWorkspaceSearchParams,
  mobileWorkspaceSearchResult,
  type ImageAttachmentMimeType,
  type MobilePrStatusParams,
  type MobilePrStatusResult,
  type MobileWorkspaceDirectoryEntry,
  type MobileWorkspaceListParams,
  type MobileWorkspaceListResult,
  type MobileWorkspaceReadFileParams,
  type MobileWorkspaceReadFileResult,
  type MobileWorkspaceSearchMatch,
  type MobileWorkspaceSearchParams,
  type MobileWorkspaceSearchResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { inspectImageBuffer, type InspectedImage } from "../services/image-inspect"
import { resolveInside, resolveRealInside } from "../services/path-safety"
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, toPosix } from "../services/workspace-files"
import { requireMobileThread } from "./command-receipts"
import { sanitizeRelativePath } from "./mentions"
import { mobileParams, MobileRequestError } from "./request-error"

/** 二进制探测检查文件头部的最大字节数（与 workspace-files.ts 保持一致）。 */
const BINARY_SNIFF_BYTES = 8 * 1024
/** 图像魔数初步探测读取的文件头大小。 */
const IMAGE_SNIFF_BYTES = 64 * 1024
/** 单帧 JSON-RPC 响应的安全上限，远低于 Noise 65,519 字节明文上限。 */
const MAX_SAFE_IMAGE_RESPONSE_BYTES = 60 * 1024
/** workspace.search 底层单次返回上限，用于判断是否发生底层截断。 */
const UNDERLYING_SEARCH_CAP = 200
/** 进程内工作区缩略图 LRU 容量，确保同一文件跨分片读取一致。 */
const THUMB_CACHE_LIMIT = 16

const windowsDrivePattern = /^[a-zA-Z]:/

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".dart": "dart",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "json",
  ".arb": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sql": "sql",
  ".xml": "xml",
  ".svg": "xml",
  ".plist": "xml",
  ".toml": "toml",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".ini": "ini",
  ".conf": "ini",
  ".txt": "plaintext",
}

export const mobileWorkbenchRequests: ReadonlySet<string> = new Set(Object.values(methods))

interface CachedThumb {
  mimeType: ImageAttachmentMimeType
  buffer: Buffer
  width?: number
  height?: number
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 根据扩展名或特殊文件名推导语法高亮提示。 */
export function detectLanguageHint(filePath: string): string | undefined {
  const name = basename(filePath).toLowerCase()
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile"
  if (name === "makefile") return "makefile"
  if (name === "cmakelists.txt") return "cmake"
  if (name === ".env" || name.startsWith(".env.")) return "dotenv"
  const ext = extname(name)
  return ext ? EXTENSION_LANGUAGES[ext] : undefined
}

/** 校验并规范化工作区相对路径；拒绝绝对路径、盘符、NUL 与 `..` 穿越段。 */
function normalizeRelativePath(raw: string, options: { allowEmpty: boolean }): string {
  if (raw === "") {
    if (options.allowEmpty) return ""
    throw new MobileRequestError("INVALID_PARAMS")
  }
  if (
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    windowsDrivePattern.test(raw) ||
    isAbsolute(raw)
  ) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  const segments = raw.replaceAll("\\", "/").split("/")
  const clean: string[] = []
  for (const segment of segments) {
    if (segment === "..") throw new MobileRequestError("INVALID_PARAMS")
    if (segment === "" || segment === ".") continue
    clean.push(segment)
  }
  if (clean.length === 0) {
    if (options.allowEmpty) return ""
    throw new MobileRequestError("INVALID_PARAMS")
  }
  const normalized = clean.join("/")
  if (normalized.length > MOBILE_WORKBENCH_PATH_MAX) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  return normalized
}

/** 目录优先于文件，同类按名称不区分大小写升序排列。 */
function compareDirectoryEntries(
  left: MobileWorkspaceDirectoryEntry,
  right: MobileWorkspaceDirectoryEntry,
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
  const leftLower = left.name.toLowerCase()
  const rightLower = right.name.toLowerCase()
  if (leftLower !== rightLower) return leftLower < rightLower ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** 裁剪单行搜索预览到 maxLength 以内，避免切裂 UTF-16 代理对。 */
function clipPreview(raw: string, maxLength: number): string {
  const singleLine = raw.replace(/[\r\n]+/g, " ")
  if (singleLine.length <= maxLength) return singleLine
  const prefix = singleLine.slice(0, maxLength - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

/** 截断在 1 MiB 处的缓冲区末尾若残留不完整 UTF-8 多字节序列，将其去掉避免出现乱码替代符。 */
function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length
  if (len === 0) return buf
  for (let back = 0; back < 4 && len - 1 - back >= 0; back += 1) {
    const byte = buf[len - 1 - back]!
    if ((byte & 0x80) === 0) return buf
    if ((byte & 0xc0) === 0xc0) {
      const expected =
        (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1
      const available = back + 1
      return available < expected ? buf.subarray(0, len - 1 - back) : buf
    }
  }
  return buf
}

function errorCodeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return (error as { code?: unknown }).code
}

/** 把底层路径/文件系统错误映射为规范的 MobileRequestError，绝不透传宿主机绝对路径。 */
function mapWorkspaceError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  const code = errorCodeOf(error)
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOOP"
  ) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith("path escapes project:") ||
      message.startsWith("absolute path not allowed:") ||
      message === "path must not be empty" ||
      message.startsWith("not a directory:") ||
      message.startsWith("not a file:")
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
  }
  throw error
}

async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0)
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export class MobileWorkbench {
  private readonly thumbCache = new Map<string, CachedThumb>()

  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
    private readonly frameByteBudget = MOBILE_WORKBENCH_FRAME_BYTES,
  ) {}

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.list:
        return this.list(mobileParams(mobileWorkspaceListParams, request.params))
      case methods.readFile:
        return this.readFile(mobileParams(mobileWorkspaceReadFileParams, request.params))
      case methods.search:
        return this.search(mobileParams(mobileWorkspaceSearchParams, request.params))
      case methods.prStatus:
        return this.prStatus(mobileParams(mobilePrStatusParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private requireWorkspace() {
    const workspace = this.ctx.get("workspace")
    if (!workspace) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return workspace
  }

  private async list(params: MobileWorkspaceListParams): Promise<MobileWorkspaceListResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const normalizedPath = normalizeRelativePath(params.path, { allowEmpty: true })

    let listing
    try {
      listing = await workspace.list(params.threadId, normalizedPath)
    } catch (error) {
      mapWorkspaceError(error)
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    const sorted: MobileWorkspaceDirectoryEntry[] = listing.entries
      .map((entry) => ({
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        ...(entry.ignored ? { ignored: true as const } : {}),
        ...(entry.symlink ? { symlink: true as const } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      }))
      .sort(compareDirectoryEntries)

    const offset = params.offset ?? 0
    const limit = params.limit ?? MOBILE_WORKBENCH_LIST_DEFAULT_LIMIT
    if (offset > sorted.length) throw new MobileRequestError("INVALID_PARAMS")

    const resultPath = normalizedPath
    const baseBytes = Buffer.byteLength(
      JSON.stringify({
        path: resultPath,
        entries: [],
        truncated: true,
        nextOffset: sorted.length,
      }),
    )

    const entries: MobileWorkspaceDirectoryEntry[] = []
    let usedBytes = baseBytes
    for (const candidate of sorted.slice(offset, offset + limit)) {
      const itemBytes = Buffer.byteLength(JSON.stringify(candidate)) + (entries.length > 0 ? 1 : 0)
      if (usedBytes + itemBytes > this.frameByteBudget) {
        if (entries.length === 0) throw new MobileRequestError("RESULT_TOO_LARGE")
        break
      }
      usedBytes += itemBytes
      entries.push(candidate)
    }

    const consumedEnd = offset + entries.length
    const hasMore = consumedEnd < sorted.length
    const nextOffset = hasMore ? consumedEnd : undefined
    const truncated = listing.truncated || hasMore

    return mobileWorkspaceListResult.parse({
      path: resultPath,
      entries,
      truncated,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    })
  }

  private async readFile(
    params: MobileWorkspaceReadFileParams,
  ): Promise<MobileWorkspaceReadFileResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
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
      return this.buildImageResult(params, canonicalPath, target, info, original, inspected, variant)
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
    info: { size: number },
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
    })
  }

  private async search(params: MobileWorkspaceSearchParams): Promise<MobileWorkspaceSearchResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = this.requireWorkspace()
    const glob = params.glob?.trim() || undefined
    const limit = params.limit ?? MOBILE_WORKBENCH_SEARCH_DEFAULT_LIMIT

    let raw
    try {
      raw = await workspace.search(params.threadId, params.query, glob)
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
      }
      if (code === 2 || code === "2") {
        throw new MobileRequestError("INVALID_PARAMS")
      }
      throw error
    }

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    const baseBytes = Buffer.byteLength(
      JSON.stringify({ query: params.query, matches: [], truncated: true }),
    )
    const matches: MobileWorkspaceSearchMatch[] = []
    let usedBytes = baseBytes
    let truncated = raw.length >= UNDERLYING_SEARCH_CAP

    for (const candidate of raw) {
      const path = sanitizeRelativePath(candidate.path)
      if (!path) continue
      if (matches.length >= limit) {
        truncated = true
        break
      }
      const match: MobileWorkspaceSearchMatch = {
        path,
        line: candidate.line,
        preview: clipPreview(candidate.text, MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX),
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(match)) + (matches.length > 0 ? 1 : 0)
      if (usedBytes + itemBytes > this.frameByteBudget) {
        truncated = true
        break
      }
      usedBytes += itemBytes
      matches.push(match)
    }

    return mobileWorkspaceSearchResult.parse({
      query: params.query,
      matches,
      truncated,
    })
  }

  private async prStatus(params: MobilePrStatusParams): Promise<MobilePrStatusResult> {
    requireMobileThread(this.ctx, params.threadId)
    const github = this.ctx.get("github")
    if (!github) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")

    const result = await github.detailedStatus(params.threadId)

    this.requirePairedDevice()
    requireMobileThread(this.ctx, params.threadId)

    return mobilePrStatusResult.parse(result)
  }
}

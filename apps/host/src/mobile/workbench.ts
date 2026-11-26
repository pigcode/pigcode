/** 手机端只读工作台处理器：目录分页浏览、文本/图片分片阅读、代码搜索与 PR 状态查询。 */
import {
  MOBILE_WORKBENCH_FRAME_BYTES,
  MOBILE_WORKBENCH_LIST_DEFAULT_LIMIT,
  MOBILE_WORKBENCH_SEARCH_DEFAULT_LIMIT,
  MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX,
  mobilePrStatusParams,
  mobilePrStatusResult,
  mobileWorkbenchMethods as methods,
  mobileWorkspaceListParams,
  mobileWorkspaceListResult,
  mobileWorkspaceReadFileParams,
  mobileWorkspaceSearchParams,
  mobileWorkspaceSearchResult,
  type MobilePrStatusParams,
  type MobilePrStatusResult,
  type MobileWorkspaceDirectoryEntry,
  type MobileWorkspaceListParams,
  type MobileWorkspaceListResult,
  type MobileWorkspaceSearchMatch,
  type MobileWorkspaceSearchParams,
  type MobileWorkspaceSearchResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { requireMobileThread } from "./command-receipts"
import { sanitizeRelativePath } from "./mentions"
import { mobileParams, MobileRequestError } from "./request-error"
import {
  clipPreview,
  compareDirectoryEntries,
  detectLanguageHint,
  errorCodeOf,
  mapWorkspaceError,
  normalizeRelativePath,
  requireWorkspace,
} from "./workbench-helpers"
import { MobileWorkbenchFileReader } from "./workbench-read"

/** workspace.search 底层单次返回上限，用于判断是否发生底层截断。 */
const UNDERLYING_SEARCH_CAP = 200

export { detectLanguageHint }

export const mobileWorkbenchRequests: ReadonlySet<string> = new Set(Object.values(methods))

export class MobileWorkbench {
  private readonly reader: MobileWorkbenchFileReader

  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
    private readonly frameByteBudget = MOBILE_WORKBENCH_FRAME_BYTES,
  ) {
    this.reader = new MobileWorkbenchFileReader(ctx, requirePairedDevice, frameByteBudget)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.list:
        return this.list(mobileParams(mobileWorkspaceListParams, request.params))
      case methods.readFile:
        return this.reader.readFile(mobileParams(mobileWorkspaceReadFileParams, request.params))
      case methods.search:
        return this.search(mobileParams(mobileWorkspaceSearchParams, request.params))
      case methods.prStatus:
        return this.prStatus(mobileParams(mobilePrStatusParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async list(params: MobileWorkspaceListParams): Promise<MobileWorkspaceListResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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

  private async search(params: MobileWorkspaceSearchParams): Promise<MobileWorkspaceSearchResult> {
    requireMobileThread(this.ctx, params.threadId)
    const workspace = requireWorkspace(this.ctx)
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

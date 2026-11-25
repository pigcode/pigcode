/** 图片附件读取缓存与 Data URL 工具：按 `(threadId, attachmentId, variant)` 缓存，避免列表滚动反复请求 Host。 */
import type {
  AttachmentReadResult,
  AttachmentReadVariant,
  ImageAttachmentMimeType,
} from "@pigcode/contracts"

export interface AttachmentCacheKey {
  attachmentId: string
  threadId?: string | undefined
  variant?: AttachmentReadVariant | undefined
}

export interface CachedAttachmentEntry {
  result: AttachmentReadResult
  dataUrl: string
}

/** 把附件二进制的 base64 编码拼成可直接用于 `<img>` 的 data URL。 */
export function toAttachmentDataUrl(
  mimeType: ImageAttachmentMimeType | string,
  dataBase64: string,
): string {
  return `data:${mimeType};base64,${dataBase64}`
}

function cacheKeyOf(params: AttachmentCacheKey): string {
  const variant = params.variant ?? "full"
  return `${params.threadId ?? ""}:${params.attachmentId}:${variant}`
}

/** 轻量 LRU 内存缓存，同时去重并发中的同一读取请求。 */
export class AttachmentReadCache {
  private readonly entries = new Map<string, CachedAttachmentEntry>()
  private readonly inflight = new Map<string, Promise<CachedAttachmentEntry>>()

  constructor(private readonly maxEntries = 128) {}

  peek(params: AttachmentCacheKey): CachedAttachmentEntry | undefined {
    const key = cacheKeyOf(params)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    // 访问后移到末尾，保持最近使用顺序。
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  peekDataUrl(params: AttachmentCacheKey): string | undefined {
    return this.peek(params)?.dataUrl
  }

  async load(
    params: AttachmentCacheKey,
    fetcher: () => Promise<AttachmentReadResult>,
  ): Promise<CachedAttachmentEntry> {
    const cached = this.peek(params)
    if (cached) return cached
    const key = cacheKeyOf(params)
    const pending = this.inflight.get(key)
    if (pending) return pending
    const request = fetcher()
      .then((result) => {
        const entry: CachedAttachmentEntry = {
          result,
          dataUrl: toAttachmentDataUrl(result.mimeType, result.dataBase64),
        }
        this.set(key, entry)
        return entry
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, request)
    return request
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }

  private set(key: string, entry: CachedAttachmentEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

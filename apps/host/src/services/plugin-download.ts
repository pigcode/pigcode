/**
 * 插件来源的下载：Host 跑在 Electron 的 utility 进程里时用 `net.fetch`（跟随系统代理与证书，
 * 访问 GitHub 更可靠），测试和普通 Node 里退回全局 fetch。下载有大小上限和超时。
 */
import { createRequire } from "node:module"

/** 下载用的 fetch；测试注入替身，不联网。 */
export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>

/** 下载失败：HTTP 状态不是 2xx。status 供调用方换成更具体的说明（404 找不到、403 被限流）。 */
export class DownloadError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`PLUGIN_DOWNLOAD_FAILED: HTTP ${status} ${url}`)
    this.name = "DownloadError"
  }
}

let electronFetcher: Fetcher | null | undefined

/** Electron 的 net.fetch；不在 Electron 里或拿不到时为 null。 */
function loadElectronFetcher(): Fetcher | null {
  if (!process.versions.electron) return null
  try {
    const electron = createRequire(import.meta.url)("electron") as {
      net?: { fetch?: Fetcher }
    }
    const fetchFromNet = electron.net?.fetch
    return fetchFromNet ? (url, init) => fetchFromNet(url, init) : null
  } catch {
    return null
  }
}

/** 默认的 fetch：优先 Electron 的 net，其次全局 fetch。 */
export function defaultFetcher(): Fetcher {
  if (electronFetcher === undefined) electronFetcher = loadElectronFetcher()
  return electronFetcher ?? ((url, init) => fetch(url, init))
}

export interface DownloadOptions {
  fetcher: Fetcher
  headers?: Record<string, string> | undefined
  /** 超过这个字节数就中止。 */
  maxBytes: number
  timeoutMs: number
}

/** 下载整个响应体；超时、超过大小上限或状态不是 2xx 时抛错。 */
export async function downloadBytes(url: string, options: DownloadOptions): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const tooLarge = () =>
    new Error(`PLUGIN_DOWNLOAD_TOO_LARGE: ${url} is larger than ${options.maxBytes} bytes`)
  try {
    const response = await options.fetcher(url, {
      ...(options.headers ? { headers: options.headers } : {}),
      signal: controller.signal,
    })
    if (!response.ok) throw new DownloadError(response.status, url)
    if (Number(response.headers.get("content-length") ?? 0) > options.maxBytes) throw tooLarge()
    const reader = response.body?.getReader()
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > options.maxBytes) throw tooLarge()
      return bytes
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > options.maxBytes) {
        controller.abort()
        throw tooLarge()
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof Error && /TOO_LARGE/.test(error.message))) {
      throw new Error(`PLUGIN_DOWNLOAD_TIMEOUT: ${url} did not finish in ${options.timeoutMs} ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

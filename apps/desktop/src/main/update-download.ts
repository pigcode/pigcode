/**
 * macOS 的「下载完整包让用户替换」（pigcode/monorepo#71）。
 *
 * 包没签名，electron-updater 装不了（ADR 0005），但可以下载 DMG 再用系统的方式打开：
 * 挂载出来的窗口里有一个 `Applications` 入口，用户把 Pigcode.app 拖进去就完成升级。
 * 用户数据在 `~/Library/Application Support/Pigcode`，换掉 .app 不影响它。
 */
import { app } from "electron"
import { createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { LatestAsset } from "./update-check"

/** 下载好的安装包，以及它的版本；用户确认后由调用方打开。 */
export interface DownloadedPackage {
  path: string
}

/** 下载时的临时目录：放在 userData 下，重启后由 clearDownloads 清掉。 */
function downloadDir(): string {
  return join(app.getPath("userData"), "update-downloads")
}

/**
 * 从 Release 的附件里挑出这个架构该用的 DMG。
 * electron-builder 给两个架构分别出 `Pigcode-<版本>.dmg`（x64）和
 * `Pigcode-<版本>-arm64.dmg`；挑不到就返回 undefined，调用方退回下载页。
 */
export function pickDmg(
  assets: readonly LatestAsset[] | undefined,
  arch: string,
): LatestAsset | undefined {
  const dmgs = (assets ?? []).filter((asset) => asset.name.toLowerCase().endsWith(".dmg"))
  if (dmgs.length === 0) return undefined
  const wantsArm = arch === "arm64"
  // 文件名里带 -arm64 的是 Apple Silicon 包，不带的是 Intel 包。
  const match = dmgs.find((asset) => /-arm64\.dmg$/i.test(asset.name) === wantsArm)
  return match
}

/** 把 URL 里的文件名取出来，去掉路径里可能带的其他片段。 */
function fileNameOf(url: string, fallback: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop()
    return name && name.toLowerCase().endsWith(".dmg") ? name : fallback
  } catch {
    return fallback
  }
}

/**
 * 下载安装包到 userData 下的临时目录，返回本地路径。
 * 失败时清掉写了一半的文件并抛出，调用方负责退回下载页。
 */
export async function downloadPackage(
  asset: LatestAsset,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (percent: number) => void,
): Promise<DownloadedPackage> {
  const dir = downloadDir()
  await mkdir(dir, { recursive: true })
  const target = join(dir, fileNameOf(asset.url, `${asset.name}`))
  const response = await fetchImpl(asset.url, { headers: { accept: "application/octet-stream" } })
  if (!response.ok || !response.body) {
    throw new Error(`update download failed: HTTP ${String(response.status)}`)
  }
  const out = createWriteStream(target)
  const total = Number(response.headers?.get("content-length") ?? 0)
  let received = 0
  try {
    // ReadableStream 是 Web 流，Node 里要逐块写；用 for await 让背压自然生效。
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (total > 0) onProgress?.(Math.min(100, (received / total) * 100))
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once("drain", resolve))
      }
    }
  } catch (error) {
    out.destroy()
    await rm(target, { force: true })
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => {
      resolve()
    })
    out.on("error", reject)
  })
  return { path: target }
}

/** 清掉上一次留下的安装包；每次启动时调一次，避免 userData 越攒越大。 */
export async function clearDownloads(): Promise<void> {
  await rm(downloadDir(), { recursive: true, force: true })
}

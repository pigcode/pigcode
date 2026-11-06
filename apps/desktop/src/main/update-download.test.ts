/** 验证 macOS 的「下载完整包」流程：按架构挑 DMG、下载到 userData、清理旧包。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** app.getPath 指向的临时 userData；每个用例换一个。 */
let userData = ""
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}))

const { clearDownloads, downloadPackage, pickDmg } = await import("./update-download")

/** 两个架构的安装包，文件名和 electron-builder 实际产出一致。 */
const assets = [
  { name: "Pigcode-0.2.0.dmg", url: "https://example.test/Pigcode-0.2.0.dmg" },
  { name: "Pigcode-0.2.0-arm64.dmg", url: "https://example.test/Pigcode-0.2.0-arm64.dmg" },
  { name: "Pigcode-0.2.0-amd64.deb", url: "https://example.test/Pigcode-0.2.0-amd64.deb" },
  { name: "latest-mac.yml", url: "https://example.test/latest-mac.yml" },
]

describe("pickDmg", () => {
  it("takes the arm64 package on Apple Silicon and the plain one on Intel", () => {
    expect(pickDmg(assets, "arm64")?.name).toBe("Pigcode-0.2.0-arm64.dmg")
    expect(pickDmg(assets, "x64")?.name).toBe("Pigcode-0.2.0.dmg")
  })

  it("returns nothing when the release has no dmg or no assets at all", () => {
    expect(pickDmg([assets[2]!], "arm64")).toBeUndefined()
    expect(pickDmg(undefined, "arm64")).toBeUndefined()
    expect(pickDmg([], "x64")).toBeUndefined()
  })
})

describe("downloadPackage", () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "pigcode-update-"))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it("writes the package under userData and returns its path", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const fetchImpl = vi.fn(async () => new Response(payload))
    const result = await downloadPackage(assets[1]!, fetchImpl as unknown as typeof fetch)
    expect(result.path).toBe(join(userData, "update-downloads", "Pigcode-0.2.0-arm64.dmg"))
    expect(readFileSync(result.path)).toEqual(Buffer.from(payload))
  })

  it("leaves no half-written file behind when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }))
    await expect(downloadPackage(assets[0]!, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /404/,
    )
    expect(existsSync(join(userData, "update-downloads", "Pigcode-0.2.0.dmg"))).toBe(false)
  })

  it("clearDownloads removes what a previous run left", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9])))
    const { path } = await downloadPackage(assets[0]!, fetchImpl as unknown as typeof fetch)
    expect(existsSync(path)).toBe(true)
    await clearDownloads()
    expect(existsSync(path)).toBe(false)
    // 目录本来就不存在时也不该抛。
    await expect(clearDownloads()).resolves.toBeUndefined()
  })

  it("keeps a stable file name when the URL has query parameters", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1])))
    const withQuery = {
      name: "Pigcode-0.2.0.dmg",
      url: "https://example.test/download/Pigcode-0.2.0.dmg?token=abc",
    }
    const { path } = await downloadPackage(withQuery, fetchImpl as unknown as typeof fetch)
    expect(path).toBe(join(userData, "update-downloads", "Pigcode-0.2.0.dmg"))
  })
})

// 确认写文件用的是流式：大文件不能整个读进内存。
describe("download internals", () => {
  it("streams the body instead of buffering it", () => {
    const source = readFileSync(new URL("./update-download.ts", import.meta.url), "utf8")
    expect(source).toContain("createWriteStream")
    expect(source).not.toContain("arrayBuffer()")
  })
})

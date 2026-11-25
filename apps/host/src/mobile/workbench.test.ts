import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  mobileFeatures,
  mobileWorkbenchMethods,
  type MobilePrStatusResult,
  type MobileWorkspaceListResult,
  type MobileWorkspaceReadFileResult,
  type MobileWorkspaceSearchResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as attachmentsPlugin, type AttachmentThumbnailer } from "../services/attachments"
import { currentBranch, NotAGitRepoError } from "../services/git"
import {
  GithubService,
  type BranchReader,
  type GhRunner,
} from "../services/github"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { scopeCwd } from "../services/worktrees"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

function makePng(totalBytes: number, width = 1280, height = 720): Buffer {
  const buf = Buffer.alloc(Math.max(33, totalBytes))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  for (let i = 33; i < buf.length; i++) {
    buf[i] = (i * 29 + 13) & 0xff
  }
  return buf
}

function makeJpeg(totalBytes: number, width = 360, height = 202): Buffer {
  const buf = Buffer.alloc(Math.max(20, totalBytes))
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xc0
  buf.writeUInt16BE(11, 4)
  buf[6] = 8
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  buf[11] = 3
  for (let i = 15; i < buf.length - 2; i++) {
    buf[i] = (i * 19 + 5) & 0xff
  }
  buf[buf.length - 2] = 0xff
  buf[buf.length - 1] = 0xd9
  return buf
}

function commandError(fields: { stderr?: string; code?: string }): Error {
  return Object.assign(new Error(fields.stderr ?? "gh command failed"), fields)
}

interface ClientHandle {
  deviceKey: string
  wire: MemoryTransport
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

async function setupHost(options?: {
  thumbnailer?: AttachmentThumbnailer
  ghRunner?: GhRunner
  branchReader?: BranchReader
}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(
    attachmentsPlugin,
    options?.thumbnailer ? { thumbnailer: options.thumbnailer } : {},
  )
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(workspace)
  await ctx.plugin(agents)
  ctx.provide(
    "github",
    new GithubService(
      options?.ghRunner ?? (async () => ""),
      (scope) => scopeCwd(ctx, scope),
      options?.branchReader ?? currentBranch,
    ),
  )

  const feed = new ThreadFeed(ctx)
  const devices = new PairedDevices(ctx.settings)
  const clients: ClientHandle[] = []

  function connectDevice(name: string, keyByte: number, features: readonly string[]): ClientHandle {
    const deviceKey = Buffer.alloc(32, keyByte).toString("base64url")
    if (!devices.find(deviceKey)) {
      devices.save({ publicKey: deviceKey, name, platform: "ios", lastConnectedAt: 1000 })
    }
    const wire = new MemoryTransport()
    const replies = new Map<string, (message: unknown) => void>()
    wire.client.onMessage((message) => {
      const record = message as { id?: string }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
      }
    })
    const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
      computerKey: Buffer.alloc(32, 1),
      computerName: "测试电脑",
      deviceKey,
      features,
      relayRevision: () => undefined,
    })
    mobile.start()

    const handle: ClientHandle = {
      deviceKey,
      wire,
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        assertSingleNoiseFrame(request)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        const reply = (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
        assertSingleNoiseFrame(reply)
        return reply
      },
      stop() {
        mobile.stop()
      },
    }
    clients.push(handle)
    return handle
  }

  return {
    ctx,
    devices,
    connectDevice,
    async dispose() {
      for (const client of clients) client.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

describe("mobile workbench.read protocol & Host implementation", () => {
  it("lists directories sorted (dirs first, case-insensitive) with 48 KiB frame-budget pagination", async () => {
    expect(mobileFeatures).toContain("workbench.read")
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-list-"))
    const host = await setupHost()
    try {
      await mkdir(join(root, "Zeta"))
      await mkdir(join(root, "alpha"))
      await mkdir(join(root, "Beta"))
      await writeFile(join(root, "gamma.ts"), "export const g = 1\n")
      await writeFile(join(root, "Alpha.md"), "# alpha\n")
      await writeFile(join(root, "beta.dart"), "void main() {}\n")

      // Create a subdirectory with hundreds of long-named files to trigger 48 KiB byte-budget paging.
      const bigDir = join(root, "many")
      await mkdir(bigDir)
      const totalMany = 360
      const suffix = "x".repeat(160)
      await Promise.all(
        Array.from({ length: totalMany }, (_, i) =>
          writeFile(join(bigDir, `item-${String(i).padStart(4, "0")}-${suffix}.txt`), "ok"),
        ),
      )

      const project = host.ctx.projects.add(root, "排序与分页项目")
      const thread = host.ctx.threads.create(project.id, "工作台会话", "fake")
      const phone = host.connectDevice("主手机", 10, ["workbench.read"])

      const rootRes = await phone.call(mobileWorkbenchMethods.list, { threadId: thread.id })
      expect(rootRes.error).toBeUndefined()
      const rootListing = rootRes.result as MobileWorkspaceListResult
      expect(rootListing.path).toBe("")
      expect(rootListing.truncated).toBe(false)
      expect(rootListing.nextOffset).toBeUndefined()
      expect(rootListing.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
        "directory:alpha",
        "directory:Beta",
        "directory:many",
        "directory:Zeta",
        "file:Alpha.md",
        "file:beta.dart",
        "file:gamma.ts",
      ])

      // Paginate through `many/` with limit 200; the 48 KiB budget forces multiple pages.
      const collected: string[] = []
      let offset = 0
      let pages = 0
      for (;;) {
        pages += 1
        const pageRes = await phone.call(mobileWorkbenchMethods.list, {
          threadId: thread.id,
          path: "many",
          offset,
          limit: 200,
        })
        expect(pageRes.error).toBeUndefined()
        const page = pageRes.result as MobileWorkspaceListResult
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024)
        for (const entry of page.entries) collected.push(entry.name)
        if (page.nextOffset === undefined) {
          expect(page.truncated).toBe(false)
          break
        }
        expect(page.truncated).toBe(true)
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      // 360 entries * ~220+ bytes JSON each > 79 KiB, so must require >= 2 pages even with limit 200.
      expect(pages).toBeGreaterThanOrEqual(2)
      expect(collected).toHaveLength(totalMany)
      expect(new Set(collected).size).toBe(totalMany)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects path traversal, external symlinks, missing files, deleted projects, subagents, revoked devices, and legacy clients without leaking host paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-sec-"))
    const outside = await mkdtemp(join(tmpdir(), "pigcode-wb-outside-"))
    const host = await setupHost()
    try {
      const secretFile = join(outside, "host-secret.txt")
      await writeFile(secretFile, "top-secret")
      await writeFile(join(root, "hello.ts"), "export const ok = true\n")
      await symlink(secretFile, join(root, "escape-file.txt"))
      await symlink(outside, join(root, "escape-dir"))

      const project = host.ctx.projects.add(root, "安全项目")
      const removedProject = host.ctx.projects.add(outside, "已删项目")
      const thread = host.ctx.threads.create(project.id, "主会话", "fake")
      const subagent = host.ctx.threads.create(project.id, "子代理", "fake", thread.id)
      const hiddenThread = host.ctx.threads.create(removedProject.id, "已删会话", "fake")
      host.ctx.projects.remove(removedProject.id)

      const phone = host.connectDevice("安全手机", 11, ["workbench.read"])
      const legacy = host.connectDevice("旧版手机", 12, ["sidebar.read", "timeline.read"])

      // Legacy client without workbench.read gets METHOD_NOT_AVAILABLE on all 4 methods.
      for (const [method, params] of [
        [mobileWorkbenchMethods.list, { threadId: thread.id }],
        [mobileWorkbenchMethods.readFile, { threadId: thread.id, path: "hello.ts" }],
        [mobileWorkbenchMethods.search, { threadId: thread.id, query: "ok" }],
        [mobileWorkbenchMethods.prStatus, { threadId: thread.id }],
      ] as const) {
        expect(await legacy.call(method, params)).toMatchObject({
          error: { code: "METHOD_NOT_AVAILABLE" },
        })
      }

      // Path traversal and absolute paths rejected without leaking host paths.
      for (const badPath of ["../host-secret.txt", "a/../../etc/passwd", secretFile, "/etc/passwd"]) {
        const listRes = await phone.call(mobileWorkbenchMethods.list, {
          threadId: thread.id,
          path: badPath,
        })
        expect(listRes.error?.code).toBe("INVALID_PARAMS")
        expect(listRes.error?.message).not.toContain(root)
        expect(listRes.error?.message).not.toContain(outside)

        const readRes = await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: badPath,
        })
        expect(readRes.error?.code).toBe("INVALID_PARAMS")
        expect(readRes.error?.message).not.toContain(root)
        expect(readRes.error?.message).not.toContain(outside)
      }

      // Symlinks pointing outside project rejected without leaking host paths.
      const escapedRead = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "escape-file.txt",
      })
      expect(escapedRead.error?.code).toBe("INVALID_PARAMS")
      expect(escapedRead.error?.message).not.toContain(outside)

      const escapedList = await phone.call(mobileWorkbenchMethods.list, {
        threadId: thread.id,
        path: "escape-dir",
      })
      expect(escapedList.error?.code).toBe("INVALID_PARAMS")
      expect(escapedList.error?.message).not.toContain(outside)

      // Missing file returns RESOURCE_NOT_AVAILABLE without leaking host path.
      const missing = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "does-not-exist.ts",
      })
      expect(missing.error?.code).toBe("RESOURCE_NOT_AVAILABLE")
      expect(missing.error?.message).not.toContain(root)

      // Deleted project thread and subagent thread are rejected.
      for (const blockedThreadId of [hiddenThread.id, subagent.id]) {
        expect(
          await phone.call(mobileWorkbenchMethods.list, { threadId: blockedThreadId }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }

      // Revoked device is rejected.
      const saved = host.devices.find(phone.deviceKey)!
      host.devices.remove(saved)
      expect(
        await phone.call(mobileWorkbenchMethods.list, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("chunks >80 KiB text (including CJK & surrogate pairs), rejects mid-surrogate offset, chunks PNG/thumb images, and detects binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-read-"))
    const fakeThumb = makeJpeg(14 * 1024, 360, 202)
    const host = await setupHost({ thumbnailer: async () => fakeThumb })
    try {
      // > 80 KiB text with CRLF, Chinese, and UTF-16 surrogate pairs (emojis).
      const line = "你好世界 🚀 const value = 'pigcode-workbench'; // 中文与表情测试\r\n"
      const bigText = line.repeat(1200)
      expect(Buffer.byteLength(bigText, "utf8")).toBeGreaterThan(80 * 1024)
      await writeFile(join(root, "large.ts"), bigText, "utf8")

      // Real PNG > 100 KiB
      const largePng = makePng(110 * 1024, 1440, 960)
      await writeFile(join(root, "screenshot.png"), largePng)

      // Non-image binary file with NUL bytes
      const binaryBuf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00, 0xff])
      await writeFile(join(root, "app.bin"), binaryBuf)

      // Spoofed SVG (text in auto mode, rejected in explicit image mode)
      await writeFile(join(root, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>")

      const project = host.ctx.projects.add(root, "阅读项目")
      const thread = host.ctx.threads.create(project.id, "阅读会话", "fake")
      const phone = host.connectDevice("阅读手机", 15, ["workbench.read"])

      // 1. Read >80 KiB text across multiple chunks and reassemble byte-for-byte.
      let assembled = ""
      let offset = 0
      let chunkCount = 0
      let lastChunk!: MobileWorkspaceReadFileResult
      for (;;) {
        chunkCount += 1
        const res = await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: "large.ts",
          offset,
          mode: "text",
        })
        expect(res.error).toBeUndefined()
        const chunk = res.result as MobileWorkspaceReadFileResult
        lastChunk = chunk
        expect(chunk.mode).toBe("text")
        expect(chunk.binary).toBe(false)
        expect(chunk.eol).toBe("crlf")
        expect(chunk.languageHint).toBe("typescript")
        assembled += chunk.text ?? ""
        if (chunk.nextOffset === undefined) {
          expect(chunk.truncated).toBe(false)
          break
        }
        expect(chunk.truncated).toBe(true)
        offset = chunk.nextOffset
      }
      expect(chunkCount).toBeGreaterThan(1)
      expect(assembled).toBe(bigText)
      expect(lastChunk.totalSize).toBe(Buffer.byteLength(bigText, "utf8"))

      // Surrogate pair mid-offset rejected with INVALID_PARAMS.
      const emojiIndex = bigText.indexOf("🚀")
      expect(emojiIndex).toBeGreaterThan(0)
      expect(
        await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: "large.ts",
          offset: emojiIndex + 1,
          mode: "text",
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      // 2. Real PNG read in image mode across multiple <= 32 KiB chunks reassembles identically.
      const pngPieces: Buffer[] = []
      let imgOffset = 0
      let imgChunks = 0
      for (;;) {
        imgChunks += 1
        const res = await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: "screenshot.png",
          offset: imgOffset,
          mode: "image",
          variant: "full",
        })
        expect(res.error).toBeUndefined()
        const chunk = res.result as MobileWorkspaceReadFileResult
        expect(chunk.mode).toBe("image")
        expect(chunk.mimeType).toBe("image/png")
        expect(chunk.width).toBe(1440)
        expect(chunk.height).toBe(960)
        const rawSlice = Buffer.from(chunk.dataBase64!, "base64")
        expect(rawSlice.length).toBeLessThanOrEqual(MOBILE_ATTACHMENT_CHUNK_BYTES)
        pngPieces.push(rawSlice)
        if (chunk.nextOffset === undefined) {
          expect(chunk.truncated).toBe(false)
          break
        }
        expect(chunk.truncated).toBe(true)
        imgOffset = chunk.nextOffset
      }
      expect(imgChunks).toBe(Math.ceil(largePng.length / MOBILE_ATTACHMENT_CHUNK_BYTES))
      expect(Buffer.concat(pngPieces).equals(largePng)).toBe(true)

      // Auto mode on PNG also detects image; thumb variant uses ctx.attachments thumbnailer.
      const thumbRes = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "screenshot.png",
        mode: "auto",
        variant: "thumb",
      })
      expect(thumbRes.error).toBeUndefined()
      const thumbChunk = thumbRes.result as MobileWorkspaceReadFileResult
      expect(thumbChunk.mode).toBe("image")
      expect(thumbChunk.mimeType).toBe("image/jpeg")
      expect(thumbChunk.nextOffset).toBeUndefined()
      expect(Buffer.from(thumbChunk.dataBase64!, "base64").equals(fakeThumb)).toBe(true)

      // 3. Binary file returns mode: "binary" cleanly.
      const binRes = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "app.bin",
      })
      expect(binRes.result).toEqual({
        path: "app.bin",
        mode: "binary",
        totalSize: binaryBuf.length,
        binary: true,
        truncated: false,
      })

      // 4. SVG rejected when explicitly requested as image, readable as xml text in auto mode.
      expect(
        await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: "icon.svg",
          mode: "image",
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_UNSUPPORTED_TYPE" } })
      expect(
        await phone.call(mobileWorkbenchMethods.readFile, {
          threadId: thread.id,
          path: "icon.svg",
          mode: "auto",
        }),
      ).toMatchObject({ result: { mode: "text", languageHint: "xml" } })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("searches code with normalized paths, line numbers, 200-char clipped previews, and limit/budget truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-search-"))
    const host = await setupHost()
    try {
      await mkdir(join(root, "src"))
      const longLine = `const needle = "${"z".repeat(260)}";`
      await writeFile(join(root, "src", "match.ts"), `line1\n${longLine}\nconst needle = 2;\n`)
      await writeFile(join(root, "src", "other.dart"), "final needle = 'dart';\n")

      const project = host.ctx.projects.add(root, "搜索项目")
      const thread = host.ctx.threads.create(project.id, "搜索会话", "fake")
      const phone = host.connectDevice("搜索手机", 16, ["workbench.read"])

      const res = await phone.call(mobileWorkbenchMethods.search, {
        threadId: thread.id,
        query: "needle",
        glob: "*.ts",
      })
      expect(res.error).toBeUndefined()
      const result = res.result as MobileWorkspaceSearchResult
      expect(result.query).toBe("needle")
      expect(result.truncated).toBe(false)
      expect(result.matches).toHaveLength(2)
      expect(result.matches[0]?.path).toBe("src/match.ts")
      expect(result.matches[0]?.line).toBe(2)
      expect(result.matches[0]!.preview.length).toBeLessThanOrEqual(200)
      expect(result.matches[0]!.preview.endsWith("…")).toBe(true)
      expect(result.matches[1]).toEqual({
        path: "src/match.ts",
        line: 3,
        preview: "const needle = 2;",
      })

      // Respect explicit limit and mark truncated: true.
      const limited = await phone.call(mobileWorkbenchMethods.search, {
        threadId: thread.id,
        query: "needle",
        limit: 1,
      })
      expect(limited.result).toMatchObject({
        query: "needle",
        truncated: true,
        matches: [expect.objectContaining({ line: expect.any(Number) })],
      })
      expect((limited.result as MobileWorkspaceSearchResult).matches).toHaveLength(1)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports structured pr.status across ok (with checksSummary), no-pr, gh-unavailable, gh-unauthenticated, no-remote, and not-git", async () => {
    const nonGitRoot = await mkdtemp(join(tmpdir(), "pigcode-wb-pr-"))
    let nextBranch: string | null | Error = "feat/workbench-read"
    let nextGh: string | Error = JSON.stringify({
      number: 149,
      title: "Mobile workbench read protocol",
      state: "OPEN",
      url: "https://github.com/pigcode/pigcode/pull/149",
      headRefName: "feat/workbench-read",
      baseRefName: "main",
      isDraft: false,
      additions: 412,
      deletions: 19,
      changedFiles: 7,
      reviewDecision: "APPROVED",
      updatedAt: "2026-11-25T15:30:00Z",
      statusCheckRollup: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
      ],
    })

    const host = await setupHost({
      branchReader: async () => {
        if (nextBranch instanceof Error) throw nextBranch
        return nextBranch
      },
      ghRunner: async () => {
        if (nextGh instanceof Error) throw nextGh
        return nextGh
      },
    })
    try {
      const project = host.ctx.projects.add(nonGitRoot, "PR 项目")
      const thread = host.ctx.threads.create(project.id, "PR 会话", "fake")
      const phone = host.connectDevice("PR 手机", 17, ["workbench.read"])

      // 1. ok with checksSummary
      const okRes = await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })
      expect(okRes.result).toEqual({
        status: "ok",
        branch: "feat/workbench-read",
        pr: {
          number: 149,
          title: "Mobile workbench read protocol",
          state: "OPEN",
          url: "https://github.com/pigcode/pigcode/pull/149",
          headRefName: "feat/workbench-read",
          baseRefName: "main",
          isDraft: false,
          additions: 412,
          deletions: 19,
          changedFiles: 7,
          reviewDecision: "APPROVED",
          updatedAt: "2026-11-25T15:30:00Z",
          checksSummary: { total: 3, passed: 1, failed: 1, pending: 1 },
        },
      } satisfies MobilePrStatusResult)

      // 2. no-pr
      nextGh = commandError({ stderr: 'no pull requests found for branch "feat/workbench-read"' })
      expect((await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result).toEqual({
        status: "no-pr",
        branch: "feat/workbench-read",
      })

      // 3. gh-unavailable
      nextGh = commandError({ code: "ENOENT" })
      expect((await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result).toEqual({
        status: "gh-unavailable",
        branch: "feat/workbench-read",
      })

      // 4. gh-unauthenticated
      nextGh = commandError({ stderr: "To get started with GitHub CLI, please run: gh auth login" })
      expect((await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result).toEqual({
        status: "gh-unauthenticated",
        branch: "feat/workbench-read",
      })

      // 5. no-remote
      nextGh = commandError({ stderr: "no git remotes found" })
      expect((await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result).toEqual({
        status: "no-remote",
        branch: "feat/workbench-read",
      })

      // 6. not-git
      nextBranch = new NotAGitRepoError(nonGitRoot)
      expect((await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result).toEqual({
        status: "not-git",
        branch: null,
      })

      // Real currentBranch on a real non-git temp directory also yields not-git!
      const realHost = await setupHost()
      try {
        const realProject = realHost.ctx.projects.add(nonGitRoot, "真实非Git目录")
        const realThread = realHost.ctx.threads.create(realProject.id, "非Git会话", "fake")
        const realPhone = realHost.connectDevice("真实非Git手机", 18, ["workbench.read"])
        expect(
          (await realPhone.call(mobileWorkbenchMethods.prStatus, { threadId: realThread.id }))
            .result,
        ).toEqual({
          status: "not-git",
          branch: null,
        })
      } finally {
        await realHost.dispose()
      }
    } finally {
      await host.dispose()
      await rm(nonGitRoot, { recursive: true, force: true })
    }
  })

  it("runs real Node Host + Dart pigcode_client end-to-end across list, text chunking, image reassembly, binary, search, pr.status, and Noise single-frame limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-dart-e2e-"))
    const host = await setupHost({
      branchReader: async () => "feat/dart-e2e",
      ghRunner: async () =>
        JSON.stringify({
          number: 202,
          title: "Dart E2E PR",
          state: "OPEN",
          url: "https://github.com/pigcode/pigcode/pull/202",
          headRefName: "feat/dart-e2e",
          baseRefName: "main",
          isDraft: false,
          additions: 88,
          deletions: 4,
          changedFiles: 3,
          reviewDecision: "APPROVED",
          updatedAt: "2026-11-25T16:00:00Z",
          statusCheckRollup: [
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
            { __typename: "StatusContext", state: "SUCCESS" },
          ],
        }),
    })

    await mkdir(join(root, "lib"))
    const bigDart = `// 中文注释 🚀\nfinal greeting = "pigcode_workbench_token";\n`.repeat(1600)
    expect(Buffer.byteLength(bigDart, "utf8")).toBeGreaterThan(80 * 1024)
    await writeFile(join(root, "lib", "huge.dart"), bigDart, "utf8")
    const e2ePng = makePng(105 * 1024, 1024, 768)
    await writeFile(join(root, "preview.png"), e2ePng)
    await writeFile(join(root, "raw.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]))

    const project = host.ctx.projects.add(root, "Dart 工作台联调项目")
    const thread = host.ctx.threads.create(project.id, "联调会话", "fake")
    const phone = host.connectDevice("Dart 工作台手机", 66, ["workbench.read"])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/workbench_e2e_driver.dart"], {
      cwd: clientPkgDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    dart.stdin.on("error", () => {})
    let stderr = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    const cmdWaiters = new Map<
      string,
      (res: { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string }) => void
    >()
    let maxOutboundEncryptedBytes = 0
    let maxInboundEncryptedBytes = 0
    let maxFrameCount = 0

    phone.wire.client.onMessage((message) => {
      const record = message as { id?: string; result?: unknown; error?: unknown }
      if (!record.id) return
      const frames = [...mobileFrames(message)]
      maxFrameCount = Math.max(maxFrameCount, frames.length)
      for (const frame of frames) {
        maxInboundEncryptedBytes = Math.max(
          maxInboundEncryptedBytes,
          frame.length + NOISE_TAG_BYTES,
        )
      }
      dart.stdin.write(
        JSON.stringify({
          dir: "rpc_res",
          id: record.id,
          ...(record.error !== undefined ? { error: record.error } : { result: record.result }),
        }) + "\n",
      )
    })

    const rl = createInterface({ input: dart.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      const msg = JSON.parse(line) as {
        dir: string
        id?: string
        method?: string
        params?: Record<string, unknown>
        cmdId?: string
        ok?: boolean
        data?: Record<string, unknown>
        error?: string
        code?: string
      }
      if (msg.dir === "rpc_req") {
        const req = {
          jsonrpc: "2.0",
          id: msg.id!,
          method: msg.method!,
          params: msg.params ?? {},
        }
        const frames = [...mobileFrames(req)]
        maxFrameCount = Math.max(maxFrameCount, frames.length)
        for (const frame of frames) {
          maxOutboundEncryptedBytes = Math.max(
            maxOutboundEncryptedBytes,
            frame.length + NOISE_TAG_BYTES,
          )
        }
        phone.wire.client.send(req)
      } else if (msg.dir === "cmd_res" && msg.cmdId) {
        const resolve = cmdWaiters.get(msg.cmdId)
        if (resolve) {
          cmdWaiters.delete(msg.cmdId)
          resolve({
            ok: msg.ok === true,
            ...(msg.data !== undefined ? { data: msg.data } : {}),
            ...(msg.error !== undefined ? { error: msg.error } : {}),
            ...(msg.code !== undefined ? { code: msg.code } : {}),
          })
        }
      }
    })

    function dartCmd(action: string, args: Record<string, unknown> = {}) {
      const cmdId = randomUUID()
      return new Promise<{
        ok: boolean
        data?: Record<string, unknown>
        error?: string
        code?: string
      }>((resolve, reject) => {
        const onExit = (code: number | null) => {
          cmdWaiters.delete(cmdId)
          reject(new Error(`Dart driver exited (${code}): ${stderr}`))
        }
        dart.once("exit", onExit)
        cmdWaiters.set(cmdId, (res) => {
          dart.off("exit", onExit)
          resolve(res)
        })
        dart.stdin.write(JSON.stringify({ dir: "cmd", cmdId, action, args }) + "\n")
      })
    }

    try {
      // 1. Directory listing via Dart client
      const listRes = await dartCmd("listDirectory", { threadId: thread.id })
      expect(listRes.ok, listRes.error).toBe(true)
      expect(listRes.data!.listing).toMatchObject({
        path: "",
        truncated: false,
        entries: [
          expect.objectContaining({ name: "lib", kind: "directory" }),
          expect.objectContaining({ name: "preview.png", kind: "file" }),
          expect.objectContaining({ name: "raw.bin", kind: "file" }),
        ],
      })

      // 2. Large text file chunked reading & 100% identical reassembly via Dart client
      const textRes = await dartCmd("readFileAllText", {
        threadId: thread.id,
        path: "lib/huge.dart",
      })
      expect(textRes.ok, textRes.error).toBe(true)
      expect(textRes.data!.chunkCount).toBeGreaterThan(1)
      expect(textRes.data!.languageHint).toBe("dart")
      expect(textRes.data!.eol).toBe("lf")
      expect(textRes.data!.truncated).toBe(false)
      expect(textRes.data!.text).toBe(bigDart)

      // 3. Real PNG image chunked reassembly via Dart `readFileImage`
      const imgRes = await dartCmd("readFileImage", {
        threadId: thread.id,
        path: "preview.png",
      })
      expect(imgRes.ok, imgRes.error).toBe(true)
      expect(imgRes.data!.mimeType).toBe("image/png")
      expect(imgRes.data!.width).toBe(1024)
      expect(imgRes.data!.height).toBe(768)
      expect(Buffer.from(imgRes.data!.dataBase64 as string, "base64").equals(e2ePng)).toBe(true)
      const imgProgress = imgRes.data!.progress as Array<[number, number]>
      expect(imgProgress.length).toBe(Math.ceil(e2ePng.length / MOBILE_ATTACHMENT_CHUNK_BYTES))
      expect(imgProgress.at(-1)).toEqual([e2ePng.length, e2ePng.length])

      // 4. Non-image binary file via Dart client
      const binRes = await dartCmd("readFile", {
        threadId: thread.id,
        path: "raw.bin",
      })
      expect(binRes.ok, binRes.error).toBe(true)
      expect(binRes.data!.chunk).toEqual({
        path: "raw.bin",
        mode: "binary",
        totalSize: 4,
        binary: true,
        truncated: false,
      })

      // 5. Code search via Dart client
      const searchRes = await dartCmd("searchFiles", {
        threadId: thread.id,
        query: "pigcode_workbench_token",
        limit: 5,
      })
      expect(searchRes.ok, searchRes.error).toBe(true)
      expect(searchRes.data!.result).toMatchObject({
        query: "pigcode_workbench_token",
        truncated: true,
      })
      expect(
        (searchRes.data!.result as { matches: unknown[] }).matches,
      ).toHaveLength(5)

      // 6. PR status via Dart client
      const prRes = await dartCmd("getPrStatus", { threadId: thread.id })
      expect(prRes.ok, prRes.error).toBe(true)
      expect(prRes.data!.result).toEqual({
        status: "ok",
        branch: "feat/dart-e2e",
        pr: {
          number: 202,
          title: "Dart E2E PR",
          state: "OPEN",
          url: "https://github.com/pigcode/pigcode/pull/202",
          headRefName: "feat/dart-e2e",
          baseRefName: "main",
          isDraft: false,
          additions: 88,
          deletions: 4,
          changedFiles: 3,
          reviewDecision: "APPROVED",
          updatedAt: "2026-11-25T16:00:00Z",
          checksSummary: { total: 2, passed: 2, failed: 0, pending: 0 },
        },
      })

      // 7. Path traversal rejected cleanly via Dart client
      const escapeRes = await dartCmd("readFile", {
        threadId: thread.id,
        path: "../escape.txt",
      })
      expect(escapeRes.ok).toBe(false)
      expect(escapeRes.code).toBe("INVALID_PARAMS")

      // Every single encrypted frame strictly <= 65,535 bytes and single-frame!
      expect(maxFrameCount).toBe(1)
      expect(maxOutboundEncryptedBytes).toBeGreaterThan(0)
      expect(maxOutboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
      expect(maxInboundEncryptedBytes).toBeGreaterThan(0)
      expect(maxInboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
    } finally {
      if (!dart.stdin.destroyed && dart.exitCode === null) {
        dart.stdin.write(JSON.stringify({ dir: "exit" }) + "\n")
        dart.stdin.end()
      }
      rl.close()
      dart.kill()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

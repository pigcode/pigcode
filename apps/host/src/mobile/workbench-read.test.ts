import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  mobileWorkbenchMethods,
  type MobilePrStatusResult,
  type MobileWorkspaceReadFileResult,
  type MobileWorkspaceSearchResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { NotAGitRepoError } from "../services/git"
import { commandError, makeJpeg, makePng, setupWorkbenchReadHost } from "./workbench-test-helper"

describe("mobile workbench.read file reading, search, and PR status", () => {
  it("chunks >80 KiB text (including CJK & surrogate pairs), rejects mid-surrogate offset, chunks PNG/thumb images, and detects binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-read-"))
    const fakeThumb = makeJpeg(14 * 1024, 360, 202)
    const host = await setupWorkbenchReadHost({ thumbnailer: async () => fakeThumb })
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
        mtimeMs: expect.any(Number),
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
    const host = await setupWorkbenchReadHost()
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

    const host = await setupWorkbenchReadHost({
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
      expect(
        (await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result,
      ).toEqual({
        status: "no-pr",
        branch: "feat/workbench-read",
      })

      // 3. gh-unavailable
      nextGh = commandError({ code: "ENOENT" })
      expect(
        (await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result,
      ).toEqual({
        status: "gh-unavailable",
        branch: "feat/workbench-read",
      })

      // 4. gh-unauthenticated
      nextGh = commandError({ stderr: "To get started with GitHub CLI, please run: gh auth login" })
      expect(
        (await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result,
      ).toEqual({
        status: "gh-unauthenticated",
        branch: "feat/workbench-read",
      })

      // 5. no-remote
      nextGh = commandError({ stderr: "no git remotes found" })
      expect(
        (await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result,
      ).toEqual({
        status: "no-remote",
        branch: "feat/workbench-read",
      })

      // 6. not-git
      nextBranch = new NotAGitRepoError(nonGitRoot)
      expect(
        (await phone.call(mobileWorkbenchMethods.prStatus, { threadId: thread.id })).result,
      ).toEqual({
        status: "not-git",
        branch: null,
      })

      // Real currentBranch on a real non-git temp directory also yields not-git!
      const realHost = await setupWorkbenchReadHost()
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
})

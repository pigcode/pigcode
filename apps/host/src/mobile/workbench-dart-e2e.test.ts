import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MOBILE_ATTACHMENT_CHUNK_BYTES } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import {
  MAX_NOISE_ENCRYPTED_FRAME_BYTES,
  makePng,
  setupWorkbenchReadHost,
  startDartWorkbenchDriver,
} from "./workbench-test-helper"

describe("mobile workbench.read Dart end-to-end", () => {
  it("runs real Node Host + Dart pigcode_client end-to-end across list, text chunking, image reassembly, binary, search, pr.status, and Noise single-frame limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wb-dart-e2e-"))
    const host = await setupWorkbenchReadHost({
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
    const driver = startDartWorkbenchDriver(phone, "test/workbench_e2e_driver.dart")

    try {
      // 1. Directory listing via Dart client
      const listRes = await driver.cmd("listDirectory", { threadId: thread.id })
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
      const textRes = await driver.cmd("readFileAllText", {
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
      const imgRes = await driver.cmd("readFileImage", {
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
      const binRes = await driver.cmd("readFile", {
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
        mtimeMs: expect.any(Number),
      })

      // 5. Code search via Dart client
      const searchRes = await driver.cmd("searchFiles", {
        threadId: thread.id,
        query: "pigcode_workbench_token",
        limit: 5,
      })
      expect(searchRes.ok, searchRes.error).toBe(true)
      expect(searchRes.data!.result).toMatchObject({
        query: "pigcode_workbench_token",
        truncated: true,
      })
      expect((searchRes.data!.result as { matches: unknown[] }).matches).toHaveLength(5)

      // 6. PR status via Dart client
      const prRes = await driver.cmd("getPrStatus", { threadId: thread.id })
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
      const escapeRes = await driver.cmd("readFile", {
        threadId: thread.id,
        path: "../escape.txt",
      })
      expect(escapeRes.ok).toBe(false)
      expect(escapeRes.code).toBe("INVALID_PARAMS")

      // Every single encrypted frame strictly <= 65,535 bytes and single-frame!
      const stats = driver.stats()
      expect(stats.maxFrameCount).toBe(1)
      expect(stats.maxOutboundEncryptedBytes).toBeGreaterThan(0)
      expect(stats.maxOutboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
      expect(stats.maxInboundEncryptedBytes).toBeGreaterThan(0)
      expect(stats.maxInboundEncryptedBytes).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
    } finally {
      driver.close()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

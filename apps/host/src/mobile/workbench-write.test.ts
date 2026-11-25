import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
  MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  MOBILE_WORKBENCH_WRITE_MAX_BYTES,
  mobileFeatures,
  mobileWorkbenchMethods,
  mobileWorkbenchWriteMethods,
  type MobileCheckpointCreateResult,
  type MobileCheckpointListResult,
  type MobileCheckpointRestoreResult,
  type MobilePrStatusResult,
  type MobileWorkspaceReadFileResult,
  type MobileWorkspaceWriteFileResult,
  type MobileWorkspaceWriteStartResult,
  type MobileWorktreeCreateResult,
  type MobileWorktreeListResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import { FAKE_LONG_RUN_TEXT, FakeAgentDriver } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as checkpoints } from "../services/checkpoints"
import { apply as git, currentBranch } from "../services/git"
import { GithubService, type BranchReader, type GhRunner } from "../services/github"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { apply as worktrees, scopeCwd } from "../services/worktrees"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { revokeDeviceWork } from "./revocation"
import { MobileSidebarRpc } from "./sidebar-rpc"
import { MobileWorkbenchWrite } from "./workbench-write"

const exec = promisify(execFile)
const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

function commandError(fields: { stderr?: string; code?: string }): Error {
  return Object.assign(new Error(fields.stderr ?? "gh command failed"), fields)
}

async function initGitRepo(root: string): Promise<void> {
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "README.md"), "# pigcode\n")
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "init"], { cwd: root })
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
  ghRunner?: GhRunner
  branchReader?: BranchReader
  agent?: FakeAgentDriver
}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(git)
  await ctx.plugin(workspace)
  await ctx.plugin(worktrees)
  await ctx.plugin(checkpoints)
  await ctx.plugin(agents)
  if (options?.agent) {
    ctx.agents.register(options.agent)
  }
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

describe("mobile workbench.write protocol & Host implementation", { timeout: 30_000 }, () => {
  it("saves small files inline, detects mtime conflict, rejects >32 KiB inline, and chunks large files with SHA-256 & cleanup", async () => {
    expect(mobileFeatures).toContain("workbench.write")
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-files-"))
    const host = await setupHost()
    try {
      await writeFile(join(root, "notes.txt"), "one\r\ntwo\r\n", "utf8")
      await writeFile(join(root, "big.ts"), "// initial\n", "utf8")

      const project = host.ctx.projects.add(root, "文件写入项目")
      const thread = host.ctx.threads.create(project.id, "写文件会话", "fake")
      const phone = host.connectDevice("写文件手机", 21, ["workbench.read", "workbench.write"])

      // 1. readFile returns mtimeMs; inline save preserves CRLF
      const readRes = await phone.call(mobileWorkbenchMethods.readFile, {
        threadId: thread.id,
        path: "notes.txt",
        mode: "text",
      })
      const initial = readRes.result as MobileWorkspaceReadFileResult
      expect(initial.mtimeMs).toBeGreaterThan(0)
      expect(initial.eol).toBe("crlf")

      const savedRes = await phone.call(mobileWorkbenchWriteMethods.writeFile, {
        threadId: thread.id,
        path: "notes.txt",
        text: "one\nthree\n",
        expectedMtimeMs: initial.mtimeMs,
        eol: initial.eol,
      })
      expect(savedRes.error).toBeUndefined()
      const saved = savedRes.result as MobileWorkspaceWriteFileResult
      expect(saved.path).toBe("notes.txt")
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("one\r\nthree\r\n")

      // 2. External modification triggers WORKBENCH_FILE_CONFLICT
      await new Promise((r) => setTimeout(r, 20))
      await writeFile(join(root, "notes.txt"), "external change\n", "utf8")
      const conflict = await phone.call(mobileWorkbenchWriteMethods.writeFile, {
        threadId: thread.id,
        path: "notes.txt",
        text: "stale edit\n",
        expectedMtimeMs: saved.mtimeMs,
      })
      expect(conflict.error?.code).toBe("WORKBENCH_FILE_CONFLICT")

      // 3. Inline > 32 KiB rejected with WORKBENCH_FILE_TOO_LARGE
      const tooBigInline = "a".repeat(MOBILE_WORKBENCH_WRITE_INLINE_MAX + 1)
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeFile, {
          threadId: thread.id,
          path: "big.ts",
          text: tooBigInline,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_FILE_TOO_LARGE" } })

      // 4. Chunked write > 32 KiB with CJK + emoji succeeds with exact SHA-256 verification
      const largeText = "你好世界 🚀 const token = 'pigcode-write';\n".repeat(1400)
      const largeBuf = Buffer.from(largeText, "utf8")
      expect(largeBuf.length).toBeGreaterThan(MOBILE_WORKBENCH_WRITE_INLINE_MAX)
      expect(largeBuf.length).toBeLessThan(MOBILE_WORKBENCH_WRITE_MAX_BYTES)

      const startRes = await phone.call(mobileWorkbenchWriteMethods.writeStart, {
        threadId: thread.id,
        path: "big.ts",
        totalBytes: largeBuf.length,
        sha256: sha256Hex(largeBuf),
        eol: "lf",
      })
      expect(startRes.error).toBeUndefined()
      const start = startRes.result as MobileWorkspaceWriteStartResult
      expect(start.chunkBytes).toBe(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES)

      // Out-of-order offset rejected
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: start.sessionId,
          offset: 100,
          dataBase64: Buffer.from("abc").toString("base64"),
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      // Send chunks sequentially
      for (let offset = 0; offset < largeBuf.length; offset += start.chunkBytes) {
        const slice = largeBuf.subarray(offset, Math.min(offset + start.chunkBytes, largeBuf.length))
        const chunkRes = await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: start.sessionId,
          offset,
          dataBase64: slice.toString("base64"),
        })
        expect(chunkRes.result).toEqual({ receivedBytes: offset + slice.length })
      }
      const commitRes = await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
        sessionId: start.sessionId,
      })
      expect(commitRes.error).toBeUndefined()
      expect(await readFile(join(root, "big.ts"), "utf8")).toBe(largeText)

      // 5. SHA-256 mismatch fails with WORKBENCH_HASH_MISMATCH and cleans session
      const badStart = (
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 5,
          sha256: "0".repeat(64),
        })
      ).result as MobileWorkspaceWriteStartResult
      await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
        sessionId: badStart.sessionId,
        offset: 0,
        dataBase64: Buffer.from("hello").toString("base64"),
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: badStart.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_HASH_MISMATCH" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: badStart.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 6. Oversized totalBytes (> 1 MiB) rejected with WORKBENCH_FILE_TOO_LARGE
      expect(
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: MOBILE_WORKBENCH_WRITE_MAX_BYTES + 1,
          sha256: "a".repeat(64),
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_FILE_TOO_LARGE" } })

      // 7. Disconnect cleanup releases in-flight sessions immediately
      const phone2 = host.connectDevice("断连测试手机", 22, ["workbench.write"])
      const orphan = (
        await phone2.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 10,
          sha256: sha256Hex("0123456789"),
        })
      ).result as MobileWorkspaceWriteStartResult
      phone2.stop()
      const phone2Reconnected = host.connectDevice("断连测试手机", 22, ["workbench.write"])
      expect(
        await phone2Reconnected.call(mobileWorkbenchWriteMethods.writeChunk, {
          sessionId: orphan.sessionId,
          offset: 0,
          dataBase64: Buffer.from("0123456789").toString("base64"),
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 8. Device revocation cleans up sessions too
      const phone3 = host.connectDevice("撤销手机", 23, ["workbench.write"])
      const revSession = (
        await phone3.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 4,
          sha256: sha256Hex("test"),
        })
      ).result as MobileWorkspaceWriteStartResult
      revokeDeviceWork(host.ctx, phone3.deviceKey)
      expect(
        await phone3.call(mobileWorkbenchWriteMethods.writeCommit, {
          sessionId: revSession.sessionId,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_WRITE_SESSION_NOT_FOUND" } })

      // 9. Concurrent double writeCommit: session is atomically removed before any await so only one commits
      const raceText = "race-commit-payload\n"
      const raceStart = (
        await phone.call(mobileWorkbenchWriteMethods.writeStart, {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: Buffer.byteLength(raceText, "utf8"),
          sha256: sha256Hex(raceText),
        })
      ).result as MobileWorkspaceWriteStartResult
      await phone.call(mobileWorkbenchWriteMethods.writeChunk, {
        sessionId: raceStart.sessionId,
        offset: 0,
        dataBase64: Buffer.from(raceText, "utf8").toString("base64"),
      })
      const [commitA, commitB] = await Promise.all([
        phone.call(mobileWorkbenchWriteMethods.writeCommit, { sessionId: raceStart.sessionId }),
        phone.call(mobileWorkbenchWriteMethods.writeCommit, { sessionId: raceStart.sessionId }),
      ])
      const successes = [commitA, commitB].filter((res) => res.error === undefined)
      const failures = [commitA, commitB].filter((res) => res.error !== undefined)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.error?.code).toBe("WORKBENCH_WRITE_SESSION_NOT_FOUND")
      expect(await readFile(join(root, "big.ts"), "utf8")).toBe(raceText)

      // 10. Idle TTL expires session cleanly
      const shortTtlWriter = new MobileWorkbenchWrite(
        host.ctx,
        phone.deviceKey,
        () => {},
        { sessionIdleTtlMs: 30 },
      )
      const ttlStart = shortTtlWriter.dispatch({
        jsonrpc: "2.0",
        id: "ttl-1",
        method: mobileWorkbenchWriteMethods.writeStart,
        params: {
          threadId: thread.id,
          path: "big.ts",
          totalBytes: 4,
          sha256: sha256Hex("test"),
        },
      }) as MobileWorkspaceWriteStartResult
      await new Promise((r) => setTimeout(r, 60))
      expect(() =>
        shortTtlWriter.dispatch({
          jsonrpc: "2.0",
          id: "ttl-2",
          method: mobileWorkbenchWriteMethods.writeChunk,
          params: {
            sessionId: ttlStart.sessionId,
            offset: 0,
            dataBase64: Buffer.from("test").toString("base64"),
          },
        }),
      ).toThrow(/过期/)
      shortTtlWriter.close()
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("handles createFile, renamePath, deletePath, non-empty dir guard, symlink escape, .git protection, and legacy client denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-fs-"))
    const outside = await mkdtemp(join(tmpdir(), "pigcode-wbw-out-"))
    const host = await setupHost()
    try {
      await mkdir(join(root, ".git"))
      await writeFile(join(root, ".git", "config"), "[core]\n")
      await writeFile(join(outside, "secret.txt"), "top-secret")
      await symlink(outside, join(root, "escape-dir"))
      await symlink(join(outside, "secret.txt"), join(root, "escape-file.txt"))
      await symlink(join(outside, "missing-target.txt"), join(root, "dangling.txt"))

      const project = host.ctx.projects.add(root, "文件管理项目")
      const thread = host.ctx.threads.create(project.id, "文件管理会话", "fake")
      const phone = host.connectDevice("管理手机", 24, ["workbench.write"])
      const legacy = host.connectDevice("旧版手机", 25, ["workbench.read"])

      // Legacy client without workbench.write receives METHOD_NOT_AVAILABLE for all 20 methods
      for (const method of Object.values(mobileWorkbenchWriteMethods)) {
        expect(await legacy.call(method, { threadId: thread.id })).toMatchObject({
          error: { code: "METHOD_NOT_AVAILABLE" },
        })
      }

      // Create nested file
      const created = await phone.call(mobileWorkbenchWriteMethods.createFile, {
        threadId: thread.id,
        path: "src/sub/new.ts",
        text: "export const n = 1\n",
      })
      expect(created.error).toBeUndefined()
      expect(created.result).toMatchObject({ path: "src/sub/new.ts", size: 19 })

      // Duplicate & dangling symlink target -> WORKBENCH_PATH_EXISTS
      expect(
        await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: "src/sub/new.ts",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_EXISTS" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: "dangling.txt",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_EXISTS" } })

      // Rename file
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.renamePath, {
            threadId: thread.id,
            oldPath: "src/sub/new.ts",
            newPath: "src/moved/item.ts",
          })
        ).result,
      ).toEqual({ oldPath: "src/sub/new.ts", newPath: "src/moved/item.ts" })

      // Non-empty directory delete blocked without recursive
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: "src/moved",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_DIR_NOT_EMPTY" } })

      // Recursive delete succeeds
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.deletePath, {
            threadId: thread.id,
            path: "src",
            recursive: true,
          })
        ).result,
      ).toEqual({ path: "src", deleted: true })

      // Deleting external symlink deletes only symlink, leaving outside target untouched
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.deletePath, {
            threadId: thread.id,
            path: "escape-file.txt",
          })
        ).result,
      ).toEqual({ path: "escape-file.txt", deleted: true })
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top-secret")

      // Forbidden paths: .git (case-insensitive), root, .., external symlink parent -> WORKBENCH_PATH_FORBIDDEN
      for (const bad of [
        ".git/config",
        ".GIT",
        ".GIT/config",
        "sub/.GIT",
        ".git/hooks/x",
        ".",
        "../out.txt",
        "escape-dir/pwn.txt",
      ]) {
        const res = await phone.call(mobileWorkbenchWriteMethods.createFile, {
          threadId: thread.id,
          path: bad,
          text: "nope",
        })
        expect(res.error?.code, `createFile ${bad}`).toBe("WORKBENCH_PATH_FORBIDDEN")
        expect(res.error?.message).not.toContain(root)
        expect(res.error?.message).not.toContain(outside)
      }
      expect(
        await phone.call(mobileWorkbenchWriteMethods.renamePath, {
          threadId: thread.id,
          oldPath: "dangling.txt",
          newPath: "sub/.GIT",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: ".git",
          recursive: true,
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.deletePath, {
          threadId: thread.id,
          path: ".GIT",
        }),
      ).toMatchObject({ error: { code: "WORKBENCH_PATH_FORBIDDEN" } })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("manages worktrees & checkpoints and enforces THREAD_BUSY during an active run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-git-"))
    const extraRoots: string[] = []
    await initGitRepo(root)

    const host = await setupHost({ agent: new FakeAgentDriver() })
    try {
      const project = host.ctx.projects.add(root, "Git 项目")
      const thread = host.ctx.threads.create(project.id, "Git 会话", "fake")
      const phone = host.connectDevice("Git 手机", 26, ["workbench.write"])

      // 1. Worktree list -> create -> switch -> remove (never leaks absolute path)
      const initialList = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeList, { threadId: thread.id })
      ).result as MobileWorktreeListResult
      expect(initialList).toEqual({ worktrees: [], mainActive: true })

      const wtCreate = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeCreate, { threadId: thread.id })
      ).result as MobileWorktreeCreateResult
      const activePath = host.ctx.worktrees.activePath(thread.id)!
      extraRoots.push(activePath)
      expect(wtCreate.worktree.active).toBe(true)
      expect(wtCreate.worktree.name).not.toContain("/")
      expect(JSON.stringify(wtCreate)).not.toContain(activePath)

      const wtList = (
        await phone.call(mobileWorkbenchWriteMethods.worktreeList, { threadId: thread.id })
      ).result as MobileWorktreeListResult
      expect(wtList.mainActive).toBe(false)
      expect(wtList.worktrees).toHaveLength(1)
      expect(wtList.worktrees[0]!.id).toBe(wtCreate.worktree.id)

      // 2. Checkpoint create -> edit -> restore
      const cpCreated = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointCreate, {
          threadId: thread.id,
          label: "clean state",
        })
      ).result as MobileCheckpointCreateResult
      expect(cpCreated.checkpoint.phase).toBe("manual")
      expect(cpCreated.checkpoint.label).toBe("clean state")
      expect(cpCreated.checkpoint.restorable).toBe(true)

      const cpList = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointList, { threadId: thread.id })
      ).result as MobileCheckpointListResult
      expect(cpList.checkpoints.some((c) => c.id === cpCreated.checkpoint.id)).toBe(true)

      await writeFile(join(activePath, "README.md"), "# modified\n", "utf8")
      const restored = (
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        })
      ).result as MobileCheckpointRestoreResult
      expect(restored.checkpointId).toBe(cpCreated.checkpoint.id)
      expect(restored.affectedCount).toBeGreaterThanOrEqual(1)
      expect(restored.affectedPaths.length).toBeLessThanOrEqual(
        MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
      )
      expect(await readFile(join(activePath, "README.md"), "utf8")).toBe("# pigcode\n")

      // 3. Active run blocks worktreeSwitch, worktreeRemove, and checkpointRestore with THREAD_BUSY
      const started = await host.ctx.agents.startRun(thread.id, FAKE_LONG_RUN_TEXT)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns().some((r) => r.threadId === thread.id)).toBe(true)
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
          threadId: thread.id,
          worktreeId: wtCreate.worktree.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })

      // Cancel run & wait until idle (including final checkpoint)
      host.ctx.agents.cancelRun(started.runId)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns()).toEqual([])
      })
      await host.ctx.checkpoints.waitForFinal(started.runId)

      // 4. Active subagent run sharing the same worktree also triggers THREAD_BUSY on parent thread
      const subagent = host.ctx.threads.create(project.id, "子代理会话", "fake", thread.id)
      const subRun = await host.ctx.agents.startRun(subagent.id, FAKE_LONG_RUN_TEXT)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns().some((r) => r.threadId === subagent.id)).toBe(true)
      })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
          threadId: thread.id,
          worktreeId: wtCreate.worktree.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })
      expect(
        await phone.call(mobileWorkbenchWriteMethods.checkpointRestore, {
          threadId: thread.id,
          checkpointId: cpCreated.checkpoint.id,
        }),
      ).toMatchObject({ error: { code: "THREAD_BUSY" } })

      host.ctx.agents.cancelRun(subRun.runId)
      await vi.waitFor(() => {
        expect(host.ctx.agents.listRuns()).toEqual([])
      })
      await host.ctx.checkpoints.waitForFinal(subRun.runId)

      // Now switch and remove succeed
      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.worktreeSwitch, {
            threadId: thread.id,
            worktreeId: wtCreate.worktree.id,
          })
        ).error,
      ).toBeUndefined()
      expect(
        (await phone.call(mobileWorkbenchWriteMethods.worktreeRemove, { threadId: thread.id }))
          .result,
      ).toEqual({ removed: true })
    } finally {
      await host.dispose()
      await Promise.all(
        [root, ...extraRoots].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
      )
    }
  })

  it("executes all 6 mobile PR write operations including merge with deleteBranch and maps gh failures to PR_ACTION_FAILED", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-pr-"))
    let branch = "feat/mobile-pr"
    let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN"
    let isDraft = true
    let failNext: Error | null = null
    const ghLog: string[][] = []

    const makeDetailed = () =>
      JSON.stringify({
        number: 154,
        title: "Workbench Write PR",
        state,
        url: "https://github.com/pigcode/pigcode/pull/154",
        headRefName: "feat/mobile-pr",
        baseRefName: "main",
        isDraft,
        additions: 240,
        deletions: 12,
        changedFiles: 6,
        reviewDecision: "APPROVED",
        updatedAt: "2026-11-25T18:00:00Z",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      })

    const host = await setupHost({
      branchReader: async () => branch,
      ghRunner: async (args) => {
        ghLog.push(args)
        if (failNext) {
          const err = failNext
          failNext = null
          throw err
        }
        if (args[1] === "create") return makeDetailed()
        if (args[1] === "comment") return ""
        if (args[1] === "ready") {
          isDraft = false
          return ""
        }
        if (args[1] === "close") {
          state = "CLOSED"
          return ""
        }
        if (args[1] === "reopen") {
          state = "OPEN"
          return ""
        }
        if (args[1] === "merge") {
          state = "MERGED"
          if (args.includes("--delete-branch")) branch = "main"
          return ""
        }
        if (args[1] === "view") {
          if (args.at(-1) === "main") {
            throw commandError({ stderr: 'no pull requests found for branch "main"' })
          }
          return makeDetailed()
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`)
      },
    })

    try {
      const project = host.ctx.projects.add(root, "PR 写项目")
      const thread = host.ctx.threads.create(project.id, "PR 写会话", "fake")
      const phone = host.connectDevice("PR 写手机", 27, ["workbench.write"])

      const created = (
        await phone.call(mobileWorkbenchWriteMethods.prCreate, {
          threadId: thread.id,
          title: "Workbench Write PR",
          body: "Details",
          base: "main",
          draft: true,
        })
      ).result as MobilePrStatusResult
      expect(created.status).toBe("ok")
      expect(created.pr?.isDraft).toBe(true)

      expect(
        (
          await phone.call(mobileWorkbenchWriteMethods.prComment, {
            threadId: thread.id,
            body: "Ship it!",
          })
        ).result,
      ).toEqual({ ok: true })

      const readied = (
        await phone.call(mobileWorkbenchWriteMethods.prReady, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(readied.pr?.isDraft).toBe(false)

      const closed = (
        await phone.call(mobileWorkbenchWriteMethods.prClose, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(closed.pr?.state).toBe("CLOSED")

      const reopened = (
        await phone.call(mobileWorkbenchWriteMethods.prReopen, { threadId: thread.id })
      ).result as MobilePrStatusResult
      expect(reopened.pr?.state).toBe("OPEN")

      // Merge with deleteBranch: branch switches to main, refresh still succeeds by PR number 154!
      const merged = (
        await phone.call(mobileWorkbenchWriteMethods.prMerge, {
          threadId: thread.id,
          method: "squash",
          deleteBranch: true,
        })
      ).result as MobilePrStatusResult
      expect(merged.status).toBe("ok")
      expect(merged.pr?.state).toBe("MERGED")
      expect(branch).toBe("main")

      // gh errors map cleanly to PR_ACTION_FAILED
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        for (const err of [
          commandError({ code: "ENOENT" }),
          commandError({ stderr: "To get started with GitHub CLI, please run: gh auth login" }),
          commandError({ stderr: "no git remotes found" }),
          commandError({ stderr: "Pull request is not mergeable" }),
        ]) {
          failNext = err
          expect(
            await phone.call(mobileWorkbenchWriteMethods.prComment, {
              threadId: thread.id,
              body: "retry",
            }),
          ).toMatchObject({ error: { code: "PR_ACTION_FAILED" } })
        }
      } finally {
        errorSpy.mockRestore()
      }
      expect(ghLog.length).toBeGreaterThan(8)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("runs real Node Host <-> Dart pigcode_client workbench.write end-to-end loopback within single Noise frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-wbw-dart-e2e-"))
    const extraRoots: string[] = []
    await initGitRepo(root)
    await writeFile(join(root, "small.txt"), "initial\n", "utf8")
    await writeFile(join(root, "large.dart"), "// placeholder\n", "utf8")
    await exec("git", ["add", "."], { cwd: root })
    await exec("git", ["commit", "-qm", "add files"], { cwd: root })

    let prBranch = "feat/dart-wbw"
    let prState: "OPEN" | "CLOSED" | "MERGED" = "OPEN"
    let prDraft = true
    const makePr = () =>
      JSON.stringify({
        number: 303,
        title: "Dart Write E2E PR",
        state: prState,
        url: "https://github.com/pigcode/pigcode/pull/303",
        headRefName: "feat/dart-wbw",
        baseRefName: "main",
        isDraft: prDraft,
        additions: 55,
        deletions: 3,
        changedFiles: 2,
        reviewDecision: "APPROVED",
        updatedAt: "2026-11-25T19:00:00Z",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      })

    const host = await setupHost({
      branchReader: async () => prBranch,
      ghRunner: async (args) => {
        if (args[1] === "create") return makePr()
        if (args[1] === "comment") return ""
        if (args[1] === "ready") {
          prDraft = false
          return ""
        }
        if (args[1] === "close") {
          prState = "CLOSED"
          return ""
        }
        if (args[1] === "reopen") {
          prState = "OPEN"
          return ""
        }
        if (args[1] === "merge") {
          prState = "MERGED"
          if (args.includes("--delete-branch")) prBranch = "main"
          return ""
        }
        if (args[1] === "view") return makePr()
        throw new Error(`unexpected gh args: ${args.join(" ")}`)
      },
    })

    const project = host.ctx.projects.add(root, "Dart 写操作联调项目")
    const thread = host.ctx.threads.create(project.id, "写操作联调会话", "fake")
    const phone = host.connectDevice("Dart 写操作手机", 77, ["workbench.read", "workbench.write"])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/workbench_write_e2e_driver.dart"], {
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
      // 1. Read mtimeMs + inline writeFile + stale mtime conflict
      const readSmall = await dartCmd("readFile", { threadId: thread.id, path: "small.txt" })
      expect(readSmall.ok, readSmall.error).toBe(true)
      const initialMtime = (readSmall.data!.chunk as { mtimeMs: number }).mtimeMs
      expect(initialMtime).toBeGreaterThan(0)

      const writeSmall = await dartCmd("writeFile", {
        threadId: thread.id,
        path: "small.txt",
        text: "updated via dart\n",
        expectedMtimeMs: initialMtime,
        eol: "lf",
      })
      expect(writeSmall.ok, writeSmall.error).toBe(true)
      expect(await readFile(join(root, "small.txt"), "utf8")).toBe("updated via dart\n")

      await new Promise((r) => setTimeout(r, 20))
      await writeFile(join(root, "small.txt"), "disk edit\n", "utf8")
      const conflictRes = await dartCmd("writeFile", {
        threadId: thread.id,
        path: "small.txt",
        text: "stale\n",
        expectedMtimeMs: (writeSmall.data!.result as { mtimeMs: number }).mtimeMs,
      })
      expect(conflictRes.ok).toBe(false)
      expect(conflictRes.code).toBe("WORKBENCH_FILE_CONFLICT")

      // 2. Large (> 60 KiB) file transparently chunked & SHA-256 verified by Dart client
      const largeContent = "// 中文大文件保存 🚀\nfinal line = 'pigcode-chunk';\n".repeat(1200)
      expect(Buffer.byteLength(largeContent, "utf8")).toBeGreaterThan(60 * 1024)
      const writeLarge = await dartCmd("writeFile", {
        threadId: thread.id,
        path: "large.dart",
        text: largeContent,
        eol: "lf",
      })
      expect(writeLarge.ok, writeLarge.error).toBe(true)
      expect((writeLarge.data!.progress as unknown[]).length).toBeGreaterThan(1)
      expect(await readFile(join(root, "large.dart"), "utf8")).toBe(largeContent)

      // 2b. <= 32 KiB text with heavy JSON escaping (> 48 KiB JSON, > 65 KiB raw JSON) seamlessly falls back to chunking and stays <= 65,535 bytes!
      const escapedContent = '\u0001"\\\n'.repeat(5500)
      expect(Buffer.byteLength(escapedContent, "utf8")).toBeLessThanOrEqual(
        MOBILE_WORKBENCH_WRITE_INLINE_MAX,
      )
      expect(Buffer.byteLength(JSON.stringify(escapedContent), "utf8")).toBeGreaterThan(48 * 1024)
      const writeEscaped = await dartCmd("writeFile", {
        threadId: thread.id,
        path: "large.dart",
        text: escapedContent,
        eol: "lf",
      })
      expect(writeEscaped.ok, writeEscaped.error).toBe(true)
      expect(await readFile(join(root, "large.dart"), "utf8")).toBe(escapedContent)

      // 3. createFile -> renamePath -> deletePath (non-empty guard + recursive delete)
      const created = await dartCmd("createFile", {
        threadId: thread.id,
        path: "drafts/note.md",
        text: "# draft\n",
      })
      expect(created.ok, created.error).toBe(true)

      const renamed = await dartCmd("renamePath", {
        threadId: thread.id,
        oldPath: "drafts/note.md",
        newPath: "drafts/final.md",
      })
      expect(renamed.ok, renamed.error).toBe(true)
      expect(renamed.data!.result).toEqual({
        oldPath: "drafts/note.md",
        newPath: "drafts/final.md",
      })

      const nonEmptyDelete = await dartCmd("deletePath", {
        threadId: thread.id,
        path: "drafts",
      })
      expect(nonEmptyDelete.ok).toBe(false)
      expect(nonEmptyDelete.code).toBe("WORKBENCH_DIR_NOT_EMPTY")

      const recursiveDelete = await dartCmd("deletePath", {
        threadId: thread.id,
        path: "drafts",
        recursive: true,
      })
      expect(recursiveDelete.ok, recursiveDelete.error).toBe(true)

      // 4. Worktree lifecycle via Dart client
      const wtCreated = await dartCmd("createWorktree", { threadId: thread.id })
      expect(wtCreated.ok, wtCreated.error).toBe(true)
      const wtId = (wtCreated.data!.worktree as { id: string }).id
      const activeWtPath = host.ctx.worktrees.activePath(thread.id)!
      extraRoots.push(activeWtPath)

      const wtListed = await dartCmd("listWorktrees", { threadId: thread.id })
      expect(wtListed.ok, wtListed.error).toBe(true)
      expect(wtListed.data!.result).toMatchObject({ mainActive: false })

      const wtSwitched = await dartCmd("switchWorktree", {
        threadId: thread.id,
        worktreeId: wtId,
      })
      expect(wtSwitched.ok, wtSwitched.error).toBe(true)

      // 5. Checkpoint create -> modify -> restore via Dart client
      const cpCreated = await dartCmd("createCheckpoint", {
        threadId: thread.id,
        label: "dart-cp",
      })
      expect(cpCreated.ok, cpCreated.error).toBe(true)
      const cpId = (cpCreated.data!.checkpoint as { id: string }).id

      await writeFile(join(activeWtPath, "README.md"), "# dirty\n", "utf8")
      const cpRestored = await dartCmd("restoreCheckpoint", {
        threadId: thread.id,
        checkpointId: cpId,
      })
      expect(cpRestored.ok, cpRestored.error).toBe(true)
      expect(await readFile(join(activeWtPath, "README.md"), "utf8")).toBe("# pigcode\n")

      const wtRemoved = await dartCmd("removeWorktree", { threadId: thread.id })
      expect(wtRemoved.ok, wtRemoved.error).toBe(true)

      // 6. All PR write actions via Dart client
      const prCreated = await dartCmd("createPr", {
        threadId: thread.id,
        title: "Dart Write E2E PR",
        body: "E2E",
        draft: true,
      })
      expect(prCreated.ok, prCreated.error).toBe(true)
      expect((prCreated.data!.result as MobilePrStatusResult).pr?.isDraft).toBe(true)

      const prCommented = await dartCmd("commentPr", {
        threadId: thread.id,
        body: "LGTM from Dart",
      })
      expect(prCommented.ok, prCommented.error).toBe(true)

      const prReadied = await dartCmd("readyPr", { threadId: thread.id })
      expect((prReadied.data!.result as MobilePrStatusResult).pr?.isDraft).toBe(false)

      const prClosed = await dartCmd("closePr", { threadId: thread.id })
      expect((prClosed.data!.result as MobilePrStatusResult).pr?.state).toBe("CLOSED")

      const prReopened = await dartCmd("reopenPr", { threadId: thread.id })
      expect((prReopened.data!.result as MobilePrStatusResult).pr?.state).toBe("OPEN")

      const prMerged = await dartCmd("mergePr", {
        threadId: thread.id,
        method: "squash",
        deleteBranch: true,
      })
      expect(prMerged.ok, prMerged.error).toBe(true)
      expect((prMerged.data!.result as MobilePrStatusResult).pr?.state).toBe("MERGED")

      // Verify every Noise frame stayed strictly within single-frame 65,535-byte limit!
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
      await Promise.all(
        [root, ...extraRoots].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
      )
    }
  }, 30_000)
})

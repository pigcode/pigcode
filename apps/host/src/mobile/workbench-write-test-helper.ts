/** 手机端工作台写操作测试共享辅助工具。 */
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Context } from "cordis"
import type { FakeAgentDriver } from "../agents/fake"
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
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"
import {
  assertSingleNoiseFrame,
  commandError,
  MAX_NOISE_ENCRYPTED_FRAME_BYTES,
  startDartWorkbenchDriver,
  type ClientHandle,
} from "./workbench-test-helper"

export {
  commandError,
  MAX_NOISE_ENCRYPTED_FRAME_BYTES,
  startDartWorkbenchDriver,
  type ClientHandle,
}

export const exec = promisify(execFile)

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function initGitRepo(root: string): Promise<void> {
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "README.md"), "# pigcode\n")
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "init"], { cwd: root })
}

export async function setupWorkbenchWriteHost(options?: {
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

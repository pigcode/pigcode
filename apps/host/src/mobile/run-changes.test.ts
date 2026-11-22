import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { mobilePairingViewSchema, rpcSuccessSchema } from "@pigcode/contracts"
import type { Context } from "cordis"
import { expect, it } from "vitest"
import type { AgentRuntime, AgentSessionHandle, UserInput } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { MemoryTransport } from "../rpc/memory-transport"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as checkpoints } from "../services/checkpoints"
import { apply as git } from "../services/git"
import { apply as worktrees } from "../services/worktrees"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

const exec = promisify(execFile)
const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN
type Params = Record<string, unknown>
type Reply = { result?: unknown; error?: { code: string } }
interface MobileReader {
  call(method: string, params: Params): Promise<Reply>
  close(): void
}

class EditingAgent extends FakeAgentDriver {
  override async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    const text = input.text === "long" ? "完成🙂\n".repeat(2400) + "结束\n" : input.text + "\n"
    await writeFile(join(session.cwd, "note.txt"), text)
    runtime.emit({ type: "run.completed" })
  }
}

async function initRepository(root: string) {
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Pigcode Test"], { cwd: root })
  await writeFile(join(root, "note.txt"), "original\n")
  await exec("git", ["add", "--", "note.txt"], { cwd: root })
  await exec("git", ["commit", "-qm", "initial"], { cwd: root })
}

async function withRunRepository(
  driver: FakeAgentDriver,
  verify: (ctx: Context, root: string, mobile: MobileReader) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-checkpoint-boundary-"))
  const host = await startMobileHost({ prepare: (ctx) => ctx.agents.register(driver) })
  const { ctx } = host
  const mobile = connectMemoryReader(ctx)
  try {
    await initRepository(root)
    await ctx.plugin(git)
    await ctx.plugin(checkpoints)
    await verify(ctx, root, mobile)
  } finally {
    mobile.close()
    await host.stop()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

function gate() {
  let open!: () => void
  const waiting = new Promise<void>((resolve) => { open = resolve })
  return { waiting, open }
}

function connectMemoryReader(ctx: Context, features = ["timeline.read", "changes.read"]): MobileReader {
  const deviceKey = Buffer.alloc(32, 2).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({ publicKey: deviceKey, name: "验收手机", platform: "ios", lastConnectedAt: 1000 })
  const wire = new MemoryTransport()
  const mobile = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features,
    relayRevision: () => undefined,
  })
  mobile.start()
  return {
    async call(method, params) {
      const id = randomUUID()
      wire.client.send({ jsonrpc: "2.0", id, method, params })
      const reply = await wire.client.next()
      expect(reply).toMatchObject({ id })
      return reply as Reply
    },
    close: () => mobile.stop(),
  }
}

async function connectDartReader(host: Awaited<ReturnType<typeof startMobileHost>>): Promise<MobileReader> {
  const child = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
    cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let diagnostic = ""
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostic += chunk))
  child.on("error", (error) => (diagnostic += error.message))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const close = () => {
    child.stdin.end()
    child.kill()
  }
  function send(action: string, values: Params) {
    child.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...values }) + "\n")
  }
  async function receive() {
    const line = await lines.next()
    if (line.done) throw new Error(diagnostic || "Dart verifier exited early")
    return JSON.parse(line.value) as { stage: string; code?: string; result?: unknown }
  }
  async function desktop(method: string, params: Params = {}) {
    return rpcSuccessSchema.parse(await host.call(method, params)).result
  }

  try {
    await desktop("relay.testAndSave", { address, token })
    const { attempt } = mobilePairingViewSchema.parse(await desktop("mobile.pairing.start"))
    if (!attempt?.qr) throw new Error("missing pairing QR")
    send("pair", { qr: attempt.qr })
    const response = await receive()
    const candidate = mobilePairingViewSchema.parse(await desktop("mobile.pairing")).attempt?.candidate
    expect(candidate?.code).toBe(response.code)
    await desktop("mobile.pairing.confirm", { id: attempt.id, confirmation: candidate?.confirmation })
    expect(await receive()).toEqual({ stage: "ready" })
    return {
      async call(method, params) {
        send(method, method === "runChangeMarkers" ? params : { params })
        const reply = await receive()
        return reply.stage === "failed" && reply.code
          ? { error: { code: reply.code } }
          : { result: reply.result }
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

async function verifyHistory(useRelay: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-run-changes-"))
  const host = await startMobileHost({ prepare: (ctx) => ctx.agents.register(new EditingAgent()) })
  const { ctx } = host
  let mobile: MobileReader | undefined
  try {
    await initRepository(root)
    await ctx.plugin(git)
    await ctx.plugin(checkpoints)
    const project = ctx.projects.add(root, "改动验收")
    const thread = ctx.threads.create(project.id, "目标会话", "fake")
    const other = ctx.threads.create(project.id, "其他会话", "fake")
    mobile = useRelay ? await connectDartReader(host) : connectMemoryReader(ctx)
    const call = mobile.call

    const first = await ctx.agents.startRun(thread.id, "first")
    await first.done
    const second = await ctx.agents.startRun(thread.id, "second")
    await second.done
    await expect.poll(() => ctx.checkpoints.list(thread.id)).toHaveLength(4)
    await writeFile(join(root, "note.txt"), "later local edit\n")

    if (useRelay) {
      expect(await call("runChangeMarkers", { threadId: thread.id })).toEqual({
        result: [first.runId, second.runId],
      })
    } else {
      const legacy = connectMemoryReader(ctx, ["timeline.read"])
      try {
        expect(JSON.stringify(await legacy.call("thread.subscribe", { threadId: thread.id })))
          .not.toContain('"kind":"changes"')
        expect(await legacy.call("run.changes", { threadId: thread.id, runId: first.runId }))
          .toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
      } finally {
        legacy.close()
      }
    }

    const firstScope = { threadId: thread.id, runId: first.runId }
    const secondScope = { threadId: thread.id, runId: second.runId }
    const summary = { result: { diffAvailable: true, files: [{ path: "note.txt", added: 1, removed: 1 }] } }
    expect(await call("run.changes", firstScope)).toMatchObject(summary)
    expect(await call("run.changes", secondScope)).toMatchObject(summary)
    const firstDiff = await call("run.diff", { ...firstScope, path: "note.txt" })
    expect(firstDiff).toMatchObject({ result: { text: expect.stringContaining("-original\n+first") } })
    const secondDiff = await call("run.diff", { ...secondScope, path: "note.txt" })
    expect(secondDiff).toMatchObject({ result: { text: expect.stringContaining("-first\n+second") } })
    expect(JSON.stringify(secondDiff)).not.toContain("later local edit")
    expect(await call("run.changes", { ...firstScope, threadId: other.id })).toMatchObject({
      error: { code: "RESOURCE_NOT_AVAILABLE" },
    })
    for (const path of ["*.txt", "../note.txt", "unchanged.txt"]) {
      expect(await call("run.diff", { ...firstScope, path })).toMatchObject({
        error: { code: "RESOURCE_NOT_AVAILABLE" },
      })
    }

    const long = await ctx.agents.startRun(thread.id, "long")
    await long.done
    await expect.poll(() => ctx.checkpoints.list(thread.id)).toHaveLength(6)
    const longScope = { threadId: thread.id, runId: long.runId, path: "note.txt" }
    let patch = ""
    let offset: number | undefined = 0
    let pages = 0
    while (offset !== undefined) {
      const reply = await call("run.diff", { ...longScope, offset })
      const { text, nextOffset } = reply.result as { text: string; nextOffset?: number }
      expect(text.length).toBeLessThanOrEqual(8192)
      expect(text).not.toMatch(/[\uD800-\uDBFF]$/u)
      if (nextOffset !== undefined) expect(nextOffset).toBe(offset + text.length)
      patch += text
      offset = nextOffset
      expect(++pages).toBeLessThan(6)
    }
    expect(pages).toBeGreaterThan(1)
    expect(patch.match(/\+完成🙂/g)).toHaveLength(2400)
    expect(patch).toContain("+结束")

    await rename(join(root, ".git"), join(root, ".git-unavailable"))
    expect(await call("run.changes", firstScope)).toMatchObject({
      result: { diffAvailable: false, files: [{ path: "note.txt" }] },
    })
    expect(await call("run.diff", { ...firstScope, path: "note.txt" })).toMatchObject({
      error: { code: "RESOURCE_NOT_AVAILABLE" },
    })
  } finally {
    mobile?.close()
    await host.stop()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

it("reads two runs against their own checkpoints even after the working tree changes", () => verifyHistory(false), 15_000)

it.skipIf(!address || !token)(
  "reads historical changes and bounded patch pages from a paired Dart client over WSS",
  () => verifyHistory(true),
  35_000,
)

it("takes the final checkpoint after native interruption and before the next baseline", async () => {
  const sending = gate()
  const finish = gate()
  class CleanupAgent extends EditingAgent {
    private directory = ""

    override async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
      if (input.text !== "stop") return super.send(session, input, runtime)
      this.directory = session.cwd
      sending.open()
      await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve(), { once: true }))
    }

    override async interrupt() {
      await finish.waiting
      await writeFile(join(this.directory, "note.txt"), "native cleanup\n")
    }
  }

  await withRunRepository(new CleanupAgent(), async (ctx, root, mobile) => {
    const project = ctx.projects.add(root, "停止验收")
    const { id: threadId } = ctx.threads.create(project.id, "停止后续跑", "fake")
    const first = await ctx.agents.startRun(threadId, "stop")
    try {
      await sending.waiting
      expect(ctx.agents.cancelRun(first.runId)).toBe(true)
      await first.done
      const nextStarting = ctx.agents.startRun(threadId, "next")
      expect(await mobile.call("run.changes", { threadId, runId: first.runId })).toMatchObject({
        result: { diffAvailable: false },
      })
      finish.open()
      const next = await nextStarting
      await next.done
      await expect.poll(() => ctx.checkpoints.list(threadId)).toHaveLength(4)
      expect(await mobile.call("run.diff", { threadId, runId: first.runId, path: "note.txt" }))
        .toMatchObject({ result: { text: expect.stringContaining("-original\n+native cleanup") } })
      expect(await mobile.call("run.diff", { threadId, runId: next.runId, path: "note.txt" }))
        .toMatchObject({ result: { text: expect.stringContaining("-native cleanup\n+next") } })
    } finally {
      finish.open()
    }
  })
}, 15_000)

it("keeps concurrent changes in one working tree out of both runs' file diffs", async () => {
  const bothSending = gate()
  let started = 0
  class ParallelAgent extends EditingAgent {
    override async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
      if (++started === 2) bothSending.open()
      await bothSending.waiting
      await writeFile(join(session.cwd, input.text), "changed\n")
      runtime.emit({ type: "run.completed" })
    }
  }

  await withRunRepository(new ParallelAgent(), async (ctx, root, mobile) => {
    const project = ctx.projects.add(root, "并发验收")
    const left = ctx.threads.create(project.id, "左会话", "fake")
    const right = ctx.threads.create(project.id, "右会话", "fake")
    const first = await ctx.agents.startRun(left.id, "left.txt")
    const second = await ctx.agents.startRun(right.id, "right.txt")
    await Promise.all([first.done, second.done])
    await expect.poll(() => ctx.checkpoints.list(left.id)).toHaveLength(2)
    await expect.poll(() => ctx.checkpoints.list(right.id)).toHaveLength(2)
    for (const [threadId, runId, path] of [
      [left.id, first.runId, "left.txt"], [right.id, second.runId, "right.txt"],
    ] as const) {
      expect(await mobile.call("run.changes", { threadId, runId })).toMatchObject({
        result: { sharedWorktree: true, diffAvailable: false, files: [] },
      })
      expect(await mobile.call("run.diff", { threadId, runId, path })).toMatchObject({
        error: { code: "RESOURCE_NOT_AVAILABLE" },
      })
    }
  })
}, 15_000)

it("reads snapshots from a removed linked worktree and limits them to the original project subdirectory", async () => {
  class NestedAgent extends EditingAgent {
    override async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
      await writeFile(join(session.cwd, "..", "note.txt"), "outside project\n")
      return super.send(session, input, runtime)
    }
  }

  await withRunRepository(new NestedAgent(), async (ctx, root, mobile) => {
    const linked = await mkdtemp(join(tmpdir(), "pigcode-mobile-linked-"))
    try {
      await mkdir(join(root, "inside"))
      await writeFile(join(root, "inside", "note.txt"), "nested original\n")
      await exec("git", ["add", "--", "inside"], { cwd: root })
      await exec("git", ["commit", "-qm", "nested project"], { cwd: root })
      await exec("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: root })
      const project = ctx.projects.add(join(linked, "inside"), "旧工作树中的项目")
      const { id: threadId } = ctx.threads.create(project.id, "原工作目录", "fake")
      const run = await ctx.agents.startRun(threadId, "nested only")
      await run.done
      await expect.poll(() => ctx.checkpoints.list(threadId)).toHaveLength(2)
      await exec("git", ["worktree", "remove", "--force", linked], { cwd: root })
      expect(await mobile.call("run.changes", { threadId, runId: run.runId })).toMatchObject({
        result: { diffAvailable: true, files: [{ path: "note.txt", added: 1, removed: 1 }] },
      })
      expect(await mobile.call("run.diff", { threadId, runId: run.runId, path: "note.txt" }))
        .toMatchObject({ result: { text: expect.stringContaining("-nested original\n+nested only") } })
    } finally {
      await rm(linked, { recursive: true, force: true, maxRetries: 5 })
    }
  })
}, 15_000)

it("starts a scoped Agent session and captures the selected worktree after switching", async () => {
  await withRunRepository(new EditingAgent(), async (ctx, root, mobile) => {
    await ctx.plugin(worktrees)
    const project = ctx.projects.add(root, "恢复原生会话")
    const { id: threadId } = ctx.threads.create(project.id, "切换工作树", "fake")
    const first = await ctx.agents.startRun(threadId, "first")
    await first.done
    await expect.poll(() => ctx.checkpoints.list(threadId)).toHaveLength(2)
    const alternate = await ctx.worktrees.create(threadId)
    try {
      const next = await ctx.agents.startRun(threadId, "second")
      await next.done
      await expect.poll(() => ctx.checkpoints.list(threadId)).toHaveLength(4)
      expect(await mobile.call("run.diff", { threadId, runId: next.runId, path: "note.txt" }))
        .toMatchObject({ result: { text: expect.stringContaining("-original\n+second") } })
    } finally {
      await ctx.worktrees.remove(threadId).catch(() => undefined)
      await rm(alternate.path, { recursive: true, force: true, maxRetries: 5 })
    }
  })
}, 15_000)

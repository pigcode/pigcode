/** 验证工作台服务通过 RPC 可达，并检查终端输出通知。 */
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as checkpoints } from "../services/checkpoints"
import { apply as git } from "../services/git"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as terminal, type PtyFactory } from "../services/terminal"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { apply as worktrees } from "../services/worktrees"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

const exec = promisify(execFile)
const contexts: Context[] = []
const roots: string[] = []

/** Host 返回的单条 RPC 消息。 */
interface RpcResponse {
  jsonrpc: "2.0"
  id?: string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

/** 不加载原生模块的 fake PTY；write 会把输入回显给 data 监听器。 */
function fakePtyFactory(): PtyFactory {
  return {
    spawn() {
      let listener: ((data: string) => void) | undefined
      return {
        onData(next) {
          listener = next
        },
        onExit() {},
        write(data) {
          listener?.(`echo:${data}`)
        },
        resize() {},
        kill() {},
      }
    },
  }
}

/** 创建带工作台服务的临时项目与 RPC 通道。 */
async function setupWorkbenchRpc() {
  const root = await mkdtemp(join(tmpdir(), "pigcode-rpc-"))
  roots.push(root)
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root })
  await exec("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "README.md"), "# pigcode\n")
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "init"], { cwd: root })

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(git)
  await ctx.plugin(workspace)
  await ctx.plugin(worktrees)
  await ctx.plugin(checkpoints)
  await ctx.plugin(terminal, { ptyFactory: fakePtyFactory() })

  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "RPC", "fake")
  const transport = new MemoryTransport()
  const server = new RpcServer(ctx, transport.host)
  server.start()
  return { ctx, project, thread, transport, server }
}

/** 发送一条 RPC 请求并等待 Host 的下一条消息。 */
async function call(
  transport: MemoryTransport,
  id: string,
  method: string,
  params: unknown,
): Promise<RpcResponse> {
  transport.client.send({ jsonrpc: "2.0", id, method, params })
  return (await transport.client.next()) as RpcResponse
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
})

// 这些用例真的跑 git（检查点、worktree）；Windows runner 上一次 git 调用就可能要几百毫秒，默认 5 秒不够。
describe("workbench rpc", { timeout: 30_000 }, () => {
  it("dispatches workspace.tree", async () => {
    const { thread, transport } = await setupWorkbenchRpc()
    const response = await call(transport, "1", "workspace.tree", { threadId: thread.id })

    expect(response.error).toBeUndefined()
    expect(Array.isArray(response.result)).toBe(true)
    expect(response.result).toContainEqual({ path: "README.md", type: "file" })
  })

  it("dispatches workspace.readFile and reports path escapes", async () => {
    const { thread, transport } = await setupWorkbenchRpc()
    const read = await call(transport, "1", "workspace.readFile", {
      threadId: thread.id,
      path: "README.md",
    })
    expect(read.result).toMatchObject({ path: "README.md", text: "# pigcode\n", binary: false })

    const escape = await call(transport, "2", "workspace.readFile", {
      threadId: thread.id,
      path: "../secret",
    })
    expect(escape.error?.message).toContain("escapes project")
  })

  it("dispatches git.status and checkpoint commands", async () => {
    const { thread, transport } = await setupWorkbenchRpc()
    const status = await call(transport, "1", "git.status", { threadId: thread.id })
    expect(status.result).toMatchObject({ changed: [] })

    const created = await call(transport, "2", "checkpoint.create", {
      threadId: thread.id,
      label: "before edit",
    })
    expect(created.result).toMatchObject({ phase: "manual", label: "before edit" })

    const listed = await call(transport, "3", "checkpoint.list", { threadId: thread.id })
    expect(Array.isArray(listed.result)).toBe(true)
    expect(listed.result).toHaveLength(1)
  })

  it("opens a terminal and forwards output notifications", async () => {
    const { thread, transport } = await setupWorkbenchRpc()
    const opened = await call(transport, "1", "terminal.open", {
      threadId: thread.id,
      cols: 80,
      rows: 24,
    })
    const session = opened.result as { id: string }
    expect(session.id).toMatch(/^term_/)

    const resized = await call(transport, "2", "terminal.resize", {
      terminalId: session.id,
      cols: 100,
      rows: 30,
    })
    expect(resized.error).toBeUndefined()

    transport.client.send({
      jsonrpc: "2.0",
      id: "3",
      method: "terminal.write",
      params: { terminalId: session.id, data: "hi\n" },
    })
    const output = (await transport.client.next()) as RpcResponse
    expect(output).toMatchObject({
      method: "terminal.output",
      params: { terminalId: session.id, data: "echo:hi\n" },
    })
    expect(await transport.client.next()).toMatchObject({ id: "3", result: undefined })

    const closed = await call(transport, "4", "terminal.close", { terminalId: session.id })
    expect(closed.error).toBeUndefined()
  })

  it("dispatches worktree lifecycle commands", async () => {
    const { ctx, thread, transport } = await setupWorkbenchRpc()
    const created = await call(transport, "1", "worktree.create", { threadId: thread.id })
    const worktree = created.result as { path: string }
    expect(worktree.path).toContain("-pigcode-")

    const switched = await call(transport, "2", "worktree.switch", {
      threadId: thread.id,
      path: worktree.path,
    })
    expect(switched.result).toMatchObject({ path: worktree.path })
    expect(ctx.worktrees.activePath(thread.id)).toBe(worktree.path)

    const removed = await call(transport, "3", "worktree.remove", { threadId: thread.id })
    expect(removed.error).toBeUndefined()
    expect(ctx.worktrees.activePath(thread.id)).toBeNull()
    await rm(worktree.path, { recursive: true, force: true })
  })
})

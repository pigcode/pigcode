/** 验证工作台服务通过 RPC 可达，并检查终端输出通知。 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Thread } from "@pigcode/contracts"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agents } from "../agents/registry"
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
  return { ctx, project, thread, transport, server, root }
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
  it("reads local branches and switches or creates them without overwriting work", async () => {
    const { root, project, transport } = await setupWorkbenchRpc()
    const git = (...args: string[]) => exec("git", args, { cwd: root })
    const initial = (await git("symbolic-ref", "--short", "HEAD")).stdout.trim()
    const head = (await git("rev-parse", "HEAD")).stdout.trim()
    await git("update-ref", "refs/remotes/origin/feature", head)
    await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature")
    const projectId = project.id
    const branches = await call(transport, "1", "git.branches", { projectId })
    expect(branches.result).toEqual({
      currentBranch: initial,
      head,
      localBranches: [initial],
      remoteBranches: ["origin/feature"],
    })

    const created = await call(transport, "2", "git.createBranch", { projectId, branch: "feature" })
    expect(created.result).toMatchObject({ currentBranch: "feature", head })
    await writeFile(join(root, "README.md"), "branch version\n")
    await git("commit", "-qam", "feature change")
    await writeFile(join(root, "README.md"), "my edits\n")
    const blocked = await call(transport, "3", "git.switchBranch", { projectId, branch: initial })
    expect(blocked.error?.message).toContain("README.md")
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("my edits\n")
    await git("restore", "README.md")
    const switched = await call(transport, "4", "git.switchBranch", { projectId, branch: initial })
    expect(switched.result).toMatchObject({ currentBranch: initial, head })
    const invalid = await call(transport, "5", "git.createBranch", {
      projectId,
      branch: "--discard-changes",
    })
    expect(invalid.error?.message).toMatch(/invalid branch/i)
  })

  it("creates an isolated thread at the selected commit and keeps the project subdirectory", async () => {
    const { ctx, root, transport } = await setupWorkbenchRpc()
    await ctx.plugin(agents)
    const agent = new FakeAgentDriver()
    const createSession = vi.spyOn(agent, "createSession")
    ctx.agents.register(agent)
    const git = (...args: string[]) => exec("git", args, { cwd: root })
    const folder = join(root, "app")
    await mkdir(folder)
    await writeFile(join(folder, "marker.txt"), "base version")
    await writeFile(join(root, ".gitignore"), ".env.local\n")
    await git("add", ".")
    await git("commit", "-qm", "base")
    const base = (await git("rev-parse", "HEAD")).stdout.trim()
    await git("update-ref", "refs/remotes/origin/topic", base)
    await git("tag", "origin/topic", "HEAD^")
    await writeFile(join(folder, "marker.txt"), "local edits")
    await writeFile(join(root, ".env.local"), "copy this explicitly")
    await writeFile(join(root, ".worktreeinclude"), ".env.local\nextra.txt\n")
    await writeFile(join(root, "extra.txt"), "ordinary untracked file")

    const project = ctx.projects.add(folder)
    const created = await call(transport, "1", "thread.create", {
      projectId: project.id,
      title: "Isolated",
      worktree: { baseRef: "refs/remotes/origin/topic" },
    })
    expect(created.error).toBeUndefined()
    const thread = created.result as Thread
    const worktree = ctx.worktrees.activePath(thread.id)
    expect(worktree).toBeTruthy()
    roots.push(worktree!)
    const cwd = join(worktree!, "app")
    expect(await ctx.workspace.readFile(thread.id, "marker.txt")).toMatchObject({
      text: "base version",
    })
    expect(await readFile(join(folder, "marker.txt"), "utf8")).toBe("local edits")
    expect(await readFile(join(worktree!, ".env.local"), "utf8")).toBe("copy this explicitly")
    await expect(readFile(join(worktree!, "extra.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await call(transport, "2", "workspace.root", { threadId: thread.id })).result).toEqual({
      root: cwd,
    })
    expect(
      (await call(transport, "3", "run.start", { threadId: thread.id, text: "hello" })).error,
    ).toBeUndefined()
    await vi.waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd })),
    )

    const branch = (await ctx.worktrees.list(thread.id)).worktrees[0]?.branch
    await ctx.worktrees.remove(thread.id)
    const recreated = await ctx.worktrees.create(thread.id)
    roots.push(recreated.path)
    expect(recreated.branch).toBe(branch)
    expect(ctx.workspace.root(thread.id)).toBe(join(recreated.path, "app"))
  })

  it("leaves no thread or worktree when the selected branch cannot be used", async () => {
    const { ctx, root, project, transport } = await setupWorkbenchRpc()
    const git = (...args: string[]) => exec("git", args, { cwd: root })
    const before = (await git("worktree", "list", "--porcelain")).stdout
    const refs = (await git("for-each-ref", "refs/heads")).stdout
    const existing = ctx.threads.list(project.id)
    const failed = await call(transport, "1", "thread.create", {
      projectId: project.id,
      worktree: { baseRef: "refs/heads/deleted" },
    })
    expect(failed.error).toBeDefined()
    expect(ctx.threads.list(project.id)).toEqual(existing)
    expect((await git("worktree", "list", "--porcelain")).stdout).toBe(before)
    expect((await git("for-each-ref", "refs/heads")).stdout).toBe(refs)
  })

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

  it("opens a draft's terminal on its project and wants exactly one owner", async () => {
    const { project, thread, transport } = await setupWorkbenchRpc()
    const opened = await call(transport, "1", "terminal.open", {
      projectId: project.id,
      cols: 80,
      rows: 24,
    })
    expect(opened.result).toMatchObject({ threadId: null, projectId: project.id })

    const both = await call(transport, "2", "terminal.open", {
      threadId: thread.id,
      projectId: project.id,
      cols: 80,
      rows: 24,
    })
    expect(both.error).toBeDefined()
    const neither = await call(transport, "3", "terminal.open", { cols: 80, rows: 24 })
    expect(neither.error).toBeDefined()
  })

  it("serves files, git status and diff on a draft's project before there is a thread", async () => {
    const { ctx, project, transport } = await setupWorkbenchRpc()
    const scope = { projectId: project.id }

    const listed = await call(transport, "1", "workspace.list", { ...scope, path: "" })
    expect(listed.result).toMatchObject({
      entries: [expect.objectContaining({ name: "README.md" })],
    })
    const read = await call(transport, "2", "workspace.readFile", { ...scope, path: "README.md" })
    expect(read.result).toMatchObject({ text: "# pigcode\n" })
    const written = await call(transport, "3", "workspace.writeFile", {
      ...scope,
      path: "README.md",
      text: "# draft edit\n",
    })
    expect(written.error).toBeUndefined()

    // 草稿里看的是项目根目录的未提交改动。
    const status = await call(transport, "4", "git.status", scope)
    expect(JSON.stringify(status.result)).toContain("README.md")
    const diff = await call(transport, "5", "git.diff", {
      ...scope,
      base: "HEAD",
      head: "WORKTREE",
    })
    expect(diff.result).toContain("+# draft edit")

    // 两个都给、都不给、项目已经移除，都拒绝。
    const both = await call(transport, "6", "workspace.root", { ...scope, threadId: "th_x" })
    expect(both.error).toBeDefined()
    expect((await call(transport, "7", "git.status", {})).error).toBeDefined()
    ctx.projects.remove(project.id)
    const removed = await call(transport, "8", "workspace.root", scope)
    expect(removed.error?.message).toContain("project not found")
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

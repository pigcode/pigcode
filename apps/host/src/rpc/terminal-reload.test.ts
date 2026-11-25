/** 验证页面刷新后终端保活、列表发现、游标重放、afterReply 顺序保证、rebind 与 open 竞态清理。 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import {
  apply as terminal,
  type PtyFactory,
  type TerminalSession,
} from "../services/terminal"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { PageTransport } from "./page-transport"
import { RpcServer } from "./server"

interface RpcMessage {
  jsonrpc: "2.0"
  id?: string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: string; message: string }
}

interface FakePtyController {
  factory: PtyFactory
  resizes: Array<[number, number]>
  readonly killCount: number
  emit(data: string, index?: number): void
  exit(exitCode?: number, index?: number): void
}

const contexts: Context[] = []
const roots: string[] = []

function createFakePty(options: { onResizeOutput?: (cols: number, rows: number) => string } = {}): FakePtyController {
  const handles: Array<{
    data: Array<(chunk: string) => void>
    exit: Array<(event: { exitCode: number }) => void>
    alive: boolean
  }> = []
  const resizes: Array<[number, number]> = []
  let killCount = 0

  const factory: PtyFactory = {
    spawn() {
      const state = {
        data: [] as Array<(chunk: string) => void>,
        exit: [] as Array<(event: { exitCode: number }) => void>,
        alive: true,
      }
      handles.push(state)
      return {
        onData(listener) {
          state.data.push(listener)
        },
        onExit(listener) {
          state.exit.push(listener)
        },
        write(data) {
          if (!state.alive) return
          for (const listener of [...state.data]) listener(`echo:${data}`)
        },
        resize(cols, rows) {
          resizes.push([cols, rows])
          if (!state.alive || !options.onResizeOutput) return
          const out = options.onResizeOutput(cols, rows)
          for (const listener of [...state.data]) listener(out)
        },
        kill() {
          if (!state.alive) return
          state.alive = false
          killCount += 1
          for (const listener of [...state.exit]) listener({ exitCode: 0 })
        },
      }
    },
  }

  return {
    factory,
    resizes,
    get killCount() {
      return killCount
    },
    emit(data, index = handles.length - 1) {
      const state = handles[index]
      if (!state || !state.alive) return
      for (const listener of [...state.data]) listener(data)
    },
    exit(exitCode = 0, index = handles.length - 1) {
      const state = handles[index]
      if (!state || !state.alive) return
      state.alive = false
      for (const listener of [...state.exit]) listener({ exitCode })
    },
  }
}

async function setupReloadRpc(pty: FakePtyController) {
  const root = await mkdtemp(join(tmpdir(), "pigcode-terminal-rpc-"))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(terminal, { ptyFactory: pty.factory })
  const project = ctx.projects.add(root)
  const thread = ctx.threads.create(project.id, "Reload", "fake")
  const page = new PageTransport()
  const page1 = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  page.attach(page1.host)
  const server = new RpcServer(ctx, page)
  server.start()
  return { ctx, project, thread, page, page1, server }
}

async function rpcCall(
  transport: MemoryTransport,
  id: string,
  method: string,
  params: unknown,
): Promise<RpcMessage> {
  transport.client.send({ jsonrpc: "2.0", id, method, params })
  return (await transport.client.next()) as RpcMessage
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  )
})

describe("terminal reload rpc (#85)", () => {
  it("recovers a live terminal across page reload with full scrollback and live stream", async () => {
    const pty = createFakePty({ onResizeOutput: (cols, rows) => `[resized:${cols}x${rows}]` })
    const { thread, page, page1, server } = await setupReloadRpc(pty)

    const opened = await rpcCall(page1, "open-1", "terminal.open", {
      threadId: thread.id,
      cols: 80,
      rows: 24,
      placement: "drawer",
    })
    expect(opened.error).toBeUndefined()
    const session = opened.result as TerminalSession
    expect(session.placement).toBe("drawer")

    // 刷新前产生输出，Page 1 收到携带 cursor 的 terminal.output。
    page1.client.send({
      jsonrpc: "2.0",
      id: "write-1",
      method: "terminal.write",
      params: { terminalId: session.id, data: "before\n" },
    })
    const liveBefore = (await page1.client.next()) as RpcMessage
    expect(liveBefore).toEqual({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: session.id, data: "echo:before\n", cursor: 12 },
    })
    expect(await page1.client.next()).toMatchObject({ id: "write-1" })

    // 模拟整页刷新：释放旧页面订阅并切换传输到 Page 2。
    server.releasePage()
    const page2 = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
    page.attach(page2.host)

    // 刷新期间没有页面订阅，后台进程继续输出。
    pty.emit("during-1\n")
    pty.emit("during-2\n")
    // 旧页面不会再收到任何消息。
    await expect(Promise.race([page1.client.next(), delay(20)])).resolves.toBeNull()

    // Page 2 通过 terminal.list 发现活着的原终端。
    const listed = await rpcCall(page2, "list-1", "terminal.list", { threadId: thread.id })
    expect(listed.error).toBeUndefined()
    expect(listed.result).toEqual([
      expect.objectContaining({
        id: session.id,
        placement: "drawer",
        cursor: 30,
        cols: 80,
        rows: 24,
      }),
    ])

    // Page 2 重新附着并同步新的终端尺寸；先收到附着响应（含全部回滚），再在 afterReply 后触发 resize 与实时推送。
    const attached = await rpcCall(page2, "attach-1", "terminal.attach", {
      terminalId: session.id,
      cols: 100,
      rows: 30,
    })
    expect(attached.error).toBeUndefined()
    expect(attached.result).toEqual({
      session: expect.objectContaining({ id: session.id, cols: 80, rows: 24, cursor: 30 }),
      replay: "echo:before\nduring-1\nduring-2\n",
      cursor: 30,
      truncated: false,
    })

    // afterReply 里执行的 resize 触发的输出在 attach 响应之后推送。
    const resizeNotice = (await page2.client.next()) as RpcMessage
    expect(resizeNotice).toEqual({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: session.id, data: "[resized:100x30]", cursor: 46 },
    })
    expect(pty.resizes).toEqual([[100, 30]])

    // 后续实时写入与推送零重复、零丢失。
    page2.client.send({
      jsonrpc: "2.0",
      id: "write-2",
      method: "terminal.write",
      params: { terminalId: session.id, data: "after\n" },
    })
    const liveAfter = (await page2.client.next()) as RpcMessage
    expect(liveAfter).toEqual({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: session.id, data: "echo:after\n", cursor: 57 },
    })
    expect(await page2.client.next()).toMatchObject({ id: "write-2" })

    // 重复 attach 同一终端不会叠加重复订阅。
    const reattached = await rpcCall(page2, "attach-2", "terminal.attach", {
      terminalId: session.id,
      afterCursor: 57,
    })
    expect(reattached.result).toMatchObject({ replay: "", cursor: 57, truncated: false })
    await Promise.resolve()
    pty.emit("once\n")
    const once = (await page2.client.next()) as RpcMessage
    expect(once).toEqual({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: session.id, data: "once\n", cursor: 62 },
    })
    await expect(Promise.race([page2.client.next(), delay(20)])).resolves.toBeNull()

    server.stop()
  })

  it("rebinds a draft terminal to a thread so reload recovers it under the thread", async () => {
    const pty = createFakePty()
    const { project, thread, page, page1, server } = await setupReloadRpc(pty)

    const opened = await rpcCall(page1, "open-1", "terminal.open", {
      projectId: project.id,
      cols: 80,
      rows: 24,
      placement: "workbench",
    })
    const session = opened.result as TerminalSession
    pty.emit("draft-output\n")
    expect(await page1.client.next()).toMatchObject({
      method: "terminal.output",
      params: { terminalId: session.id, data: "draft-output\n", cursor: 13 },
    })

    const rebound = await rpcCall(page1, "rebind-1", "terminal.rebind", {
      terminalId: session.id,
      threadId: thread.id,
    })
    expect(rebound.error).toBeUndefined()
    expect(rebound.result).toMatchObject({ id: session.id, threadId: thread.id })

    server.releasePage()
    const page2 = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
    page.attach(page2.host)

    expect((await rpcCall(page2, "list-draft", "terminal.list", { projectId: project.id })).result).toEqual([])
    expect((await rpcCall(page2, "list-thread", "terminal.list", { threadId: thread.id })).result).toEqual([
      expect.objectContaining({ id: session.id, placement: "workbench", cursor: 13 }),
    ])

    const attached = await rpcCall(page2, "attach-1", "terminal.attach", {
      terminalId: session.id,
    })
    expect(attached.result).toMatchObject({ replay: "draft-output\n", cursor: 13, truncated: false })

    server.stop()
  })

  it("closes an orphan terminal opened in flight across releasePage()", async () => {
    const pty = createFakePty()
    const { ctx, thread, page, page1, server } = await setupReloadRpc(pty)

    // 发送 terminal.open 后在同一同步 tick 触发页面切换（open 仍在等待异步 realpath/stat）。
    page1.client.send({
      jsonrpc: "2.0",
      id: "open-race",
      method: "terminal.open",
      params: { threadId: thread.id, cols: 80, rows: 24 },
    })
    server.releasePage()
    const page2 = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
    page.attach(page2.host)

    await vi.waitFor(() => {
      expect(pty.killCount).toBe(1)
    })
    expect(ctx.terminal.list()).toEqual([])

    server.stop()
  })

  it("clears subscriptions on terminal.close and terminal exit", async () => {
    const pty = createFakePty()
    const { thread, page1, server } = await setupReloadRpc(pty)

    const first = (
      await rpcCall(page1, "open-1", "terminal.open", {
        threadId: thread.id,
        cols: 80,
        rows: 24,
      })
    ).result as TerminalSession

    const closed = await rpcCall(page1, "close-1", "terminal.close", { terminalId: first.id })
    expect(closed.error).toBeUndefined()
    // 重复 close 返回错误，说明终端和订阅均已清理。
    const closedAgain = await rpcCall(page1, "close-again", "terminal.close", {
      terminalId: first.id,
    })
    expect(closedAgain.error?.message).toContain("terminal not found")

    const second = (
      await rpcCall(page1, "open-2", "terminal.open", {
        threadId: thread.id,
        cols: 80,
        rows: 24,
      })
    ).result as TerminalSession
    pty.exit(7)
    expect(await page1.client.next()).toEqual({
      jsonrpc: "2.0",
      method: "terminal.exit",
      params: { terminalId: second.id, exitCode: 7 },
    })

    server.stop()
  })

  it("flushes live output arriving before attach reply strictly after the attach response", async () => {
    const pty = createFakePty()
    const { ctx, thread, page, page1, server } = await setupReloadRpc(pty)

    const opened = (
      await rpcCall(page1, "open-1", "terminal.open", {
        threadId: thread.id,
        cols: 80,
        rows: 24,
      })
    ).result as TerminalSession
    pty.emit("hist\n")
    expect(await page1.client.next()).toMatchObject({ method: "terminal.output" })

    server.releasePage()
    const page2 = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
    page.attach(page2.host)

    // 拦截 terminal.attach：在 attach 建立监听后、RPC 响应发出前同步触发一条新输出，
    // 验证 afterReply 保证响应先到、新输出后到且零重复零丢失。
    const origAttach = ctx.terminal.attach.bind(ctx.terminal)
    ctx.terminal.attach = (...args) => {
      const result = origAttach(...args)
      pty.emit("mid-flight\n")
      return result
    }

    const received: RpcMessage[] = []
    page2.client.onMessage((msg) => received.push(msg as RpcMessage))

    page2.client.send({
      jsonrpc: "2.0",
      id: "attach-order",
      method: "terminal.attach",
      params: { terminalId: opened.id },
    })

    await vi.waitFor(() => {
      expect(received).toHaveLength(2)
    })
    expect(received[0]).toMatchObject({
      id: "attach-order",
      result: { replay: "hist\n", cursor: 5, truncated: false },
    })
    expect(received[1]).toEqual({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: opened.id, data: "mid-flight\n", cursor: 16 },
    })

    server.stop()
  })
})

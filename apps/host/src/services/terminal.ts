/** 终端服务：真实实现用 node-pty，测试注入 fake factory，避免加载原生模块。 */
import type { Context } from "cordis"
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { basename } from "node:path"
import { createRequire } from "node:module"
import { terminateProcessGroup } from "@pigcode/plugin-sdk/node"
import { threadCwd } from "./worktrees"

/** PTY 的最小接口；屏蔽 node-pty 的 IDisposable 等实现细节。 */
export interface PtyLike {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  /** 结束 shell 和它的作业；返回的 Promise 在 shell 所在的组结束后完成。 */
  kill(): void | Promise<void>
}

/** spawn 所需的参数；cwd 由服务解析和校验，不接受调用方传入。 */
export interface PtySpawnInput {
  cwd: string
  cols: number
  rows: number
  shell: string
}

/** PTY 工厂；单测注入 fake，生产使用 realPtyFactory。 */
export interface PtyFactory {
  spawn(input: PtySpawnInput): PtyLike
}

/**
 * 终端挂在谁身上：会话里开的终端挂在会话上（cwd 是会话的工作目录，可能是 worktree）；
 * 新会话草稿里还没有会话，终端挂在草稿的项目上（cwd 是项目根目录）。
 */
export type TerminalOwner = { threadId: string } | { projectId: string }

/** 打开的终端会话；id 用于后续 write/resize/close/subscribe。 */
export interface TerminalSession {
  id: string
  /** 在新会话草稿里打开的终端没有会话。 */
  threadId: string | null
  /** 终端所在的项目；会话里开的终端是会话的项目。 */
  projectId: string
  cols: number
  rows: number
  /** shell 的名字（例如 zsh），界面标签上显示。 */
  shell: string
  /** shell 启动时的工作目录（线程的项目根或 worktree）。 */
  cwd: string
}

/** 终端服务入口；同一线程可以同时开多个终端（底部终端的多个标签、右栏的终端标签）。 */
export interface TerminalService {
  open(owner: TerminalOwner, cols: number, rows: number): Promise<TerminalSession>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  close(id: string): void
  /** 关闭这个线程的全部终端；没有打开的终端时什么也不做。 */
  closeThread(threadId: string): void
  /** 关闭这个项目里的全部终端，包括它的会话里的和草稿里开的。 */
  closeProject(projectId: string): void
  /** 订阅输出；onExit 在 shell 自己退出（例如输入 exit）时调用一次。 */
  subscribe(
    id: string,
    listener: (data: string) => void,
    onExit?: (exitCode: number) => void,
  ): () => void
}

declare module "cordis" {
  interface Context {
    terminal: TerminalService
  }
}

/** terminal 插件依赖的服务；worktree 路径直接从 storage 表读取。 */
export const inject = ["projects", "threads", "storage"]

/** terminal 插件配置；测试通过 ptyFactory 注入 fake。 */
export interface TerminalConfig {
  ptyFactory?: PtyFactory
}

/** terminal 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface TerminalPlugin {
  (ctx: Context, config?: TerminalConfig): void
  inject: string[]
}

/** 内部终端记录：会话、PTY 与当前订阅者。 */
interface TerminalEntry {
  session: TerminalSession
  pty: PtyLike
  subscribers: Set<(data: string) => void>
  exitSubscribers: Set<(exitCode: number) => void>
}

/** 注册 terminal 服务；Host 卸载时终止所有 PTY，终端不跨重启保留。 */
export const apply: TerminalPlugin = (ctx, config = {}) => {
  const factory = config.ptyFactory ?? realPtyFactory()
  const terminals = new Map<string, TerminalEntry>()
  /** 正在结束的 PTY；Host 退出前要等它们。 */
  const ending = new Set<Promise<void>>()

  /** 结束 PTY 但不等它：RPC 不必等 shell 退出。 */
  function endPty(pty: PtyLike): void {
    const done = Promise.resolve(pty.kill()).finally(() => ending.delete(done))
    ending.add(done)
  }

  /** 按 id 取记录；未知 id 一律报错，避免静默丢弃输入。 */
  function entry(id: string): TerminalEntry {
    const found = terminals.get(id)
    if (!found) throw new Error(`terminal not found: ${id}`)
    return found
  }

  /** 从索引移除并清空订阅者；是否 kill 由调用方决定。 */
  function detach(id: string): TerminalEntry | undefined {
    const found = terminals.get(id)
    if (!found) return undefined
    terminals.delete(id)
    found.subscribers.clear()
    found.exitSubscribers.clear()
    return found
  }

  /** 关闭终端；重复 close 会报错，便于 RPC 层发现过期 id。 */
  function close(id: string): void {
    const found = detach(id)
    if (!found) throw new Error(`terminal not found: ${id}`)
    endPty(found.pty)
  }

  const service: TerminalService = {
    async open(owner, cols, rows) {
      validateSize(cols, rows)
      const { threadId, projectId, cwd } = await resolveTerminalCwd(ctx, owner)
      const id = `term_${randomUUID()}`
      const shell = defaultShell()
      const pty = factory.spawn({ cwd, cols, rows, shell })
      const session: TerminalSession = {
        id,
        threadId,
        projectId,
        cols,
        rows,
        shell: shellName(shell),
        cwd,
      }
      const current: TerminalEntry = {
        session,
        pty,
        subscribers: new Set(),
        exitSubscribers: new Set(),
      }
      terminals.set(id, current)
      // 输出只广播给当前订阅者；shell 自己退出时通知订阅者，界面据此关掉这个标签。
      pty.onData((data) => {
        for (const listener of [...current.subscribers]) listener(data)
      })
      pty.onExit(({ exitCode }) => {
        const listeners = [...current.exitSubscribers]
        detach(id)
        for (const listener of listeners) listener(exitCode)
      })
      return session
    },
    write(id, data) {
      entry(id).pty.write(data)
    },
    resize(id, cols, rows) {
      validateSize(cols, rows)
      entry(id).pty.resize(cols, rows)
    },
    close,
    closeThread(threadId) {
      for (const [id, found] of [...terminals]) {
        if (found.session.threadId === threadId) close(id)
      }
    },
    closeProject(projectId) {
      for (const [id, found] of [...terminals]) {
        if (found.session.projectId === projectId) close(id)
      }
    },
    subscribe(id, listener, onExit) {
      const found = entry(id)
      found.subscribers.add(listener)
      if (onExit) found.exitSubscribers.add(onExit)
      return () => {
        found.subscribers.delete(listener)
        if (onExit) found.exitSubscribers.delete(onExit)
      }
    },
  }

  ctx.provide("terminal", service)
  ctx.effect(() => async () => {
    for (const found of terminals.values()) endPty(found.pty)
    terminals.clear()
    await Promise.all(ending)
  })
}

apply.inject = inject

/**
 * 解析终端 cwd：会话里与 agent 相同（会话的工作目录），草稿里是项目根目录；realpath 消除符号链接。
 * cwd 只来自数据库中的项目根或服务创建的 worktree，不接受调用方传入的路径。
 */
async function resolveTerminalCwd(
  ctx: Context,
  owner: TerminalOwner,
): Promise<{ threadId: string | null; projectId: string; cwd: string }> {
  if ("threadId" in owner) {
    const thread = ctx.threads.get(owner.threadId)
    if (!thread) throw new Error(`thread not found: ${owner.threadId}`)
    const cwd = await usableDirectory(threadCwd(ctx, owner.threadId))
    return { threadId: thread.id, projectId: thread.projectId, cwd }
  }
  // 草稿只会落在侧栏里的项目上；已经移除的项目不再开终端。
  const project = ctx.projects.list().find((item) => item.id === owner.projectId)
  if (!project) throw new Error(`project not found: ${owner.projectId}`)
  return { threadId: null, projectId: project.id, cwd: await usableDirectory(project.rootPath) }
}

/** 解开符号链接并确认是一个目录。 */
async function usableDirectory(cwd: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(cwd)
  } catch {
    throw new Error(`terminal cwd not found: ${cwd}`)
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error(`terminal cwd is not a directory: ${cwd}`)
  return resolved
}

/** 终端尺寸必须是正整数，避免把非法值传给原生 PTY。 */
function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error(`invalid terminal size: ${cols}x${rows}`)
  }
}

/** shell 路径的显示名：/bin/zsh → zsh，C:\\Windows\\System32\\cmd.exe → cmd。 */
export function shellName(shell: string): string {
  return basename(shell.replaceAll("\\", "/")).replace(/\.exe$/i, "") || shell
}

/** 当前平台的默认 shell；Windows 使用 ConPTY 对应的 COMSPEC。 */
export function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe"
  // 从 Dock 或桌面菜单启动时可能没有 SHELL；Linux 上不能退回只存在于 macOS 的 zsh。
  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"
  return process.env.SHELL ?? fallback
}

/** 真实 PTY 工厂；node-pty 是 CJS，用 createRequire 避免 ESM 默认导入问题。 */
export function realPtyFactory(): PtyFactory {
  return {
    spawn(input) {
      const require = createRequire(import.meta.url)
      const pty = require("node-pty") as typeof import("node-pty")
      const name = "xterm-256color"
      const child = pty.spawn(input.shell, [], {
        name,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        // Shell 应按内置 xterm 的能力输出，启动 Pigcode 的外层终端可能是 TERM=dumb。
        env: { ...process.env, TERM: name, COLORTERM: "truecolor" },
      })
      return {
        onData: (listener) => void child.onData(listener),
        onExit: (listener) => void child.onExit(listener),
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
        // 和关掉终端窗口一样：交互式 shell 忽略 SIGTERM，收到 SIGHUP 才退出，并把它转发给自己的作业。
        // 用户 nohup 或 disown 的进程不受影响，这是他们有意留下的。
        // Windows 上 node-pty 的 kill 要异步查询控制台里的进程，Host 退出太快就来不及了，所以先结束整棵树。
        kill: async () => {
          await terminateProcessGroup(child.pid, { signal: "SIGHUP" })
          if (process.platform !== "win32") return
          try {
            child.kill()
          } catch {
            // 控制台已经随进程一起关闭。
          }
        },
      }
    },
  }
}

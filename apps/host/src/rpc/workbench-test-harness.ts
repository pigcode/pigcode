/** 工作台 RPC 测试共享夹具：临时 git 项目、Cordis 服务与 fake PTY。 */
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Context } from "cordis"
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

export const exec = promisify(execFile)

/** Host 返回的单条 RPC 消息。 */
export interface RpcResponse {
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

/** 发送一条 RPC 请求并等待 Host 的下一条消息。 */
export async function call(
  transport: MemoryTransport,
  id: string,
  method: string,
  params: unknown,
): Promise<RpcResponse> {
  transport.client.send({ jsonrpc: "2.0", id, method, params })
  return (await transport.client.next()) as RpcResponse
}

/** 创建带自动回收的工作台 RPC 测试夹具。 */
export function createWorkbenchHarness() {
  const contexts: Context[] = []
  const roots: string[] = []

  return {
    roots,
    /** 创建带工作台服务的临时项目与 RPC 通道。 */
    async setup() {
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
      const transport = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
      const server = new RpcServer(ctx, transport.host)
      server.start()
      return { ctx, project, thread, transport, server, root }
    },
    async cleanup() {
      await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
      await Promise.all(
        roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
      )
    },
  }
}

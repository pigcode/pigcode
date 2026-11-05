/**
 * 启动 Claude Code CLI，让它自成一棵可以整体结束的进程树。SDK 默认的 spawn 只能结束 CLI 本身，
 * 所以通过 spawnClaudeCodeProcess 接管启动。
 */
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import {
  ownProcessTree,
  PROCESS_TREE_SPAWN_OPTIONS,
  type OwnedProcessTree,
} from "@pigcode/plugin-sdk/node"

/** 错误信息里保留的 stderr 末尾长度。 */
const STDERR_TAIL_CHARS = 2000
/** 进程退出后等 stderr 读完的最长时间；留下来的子进程可能一直占着这根管道。 */
const STDERR_DRAIN_MS = 200
/** 告诉 SDK 进程退出的事件：要等 stderr 读完才发，错误信息里才有完整的原因。SDK 自己的 spawn 也是这样做的。 */
const DRAINED_EXIT = "pigcode:exit"

export interface ClaudeCliProcess {
  process: SpawnedProcess
  tree: OwnedProcessTree
  stderrTail(): string
}

/** 按 SDK 给的命令启动 CLI。SDK 的取消信号要在它关闭 stdin 并等待之后才触发，这时才结束进程树。 */
export function spawnClaudeCli(options: SpawnOptions): ClaudeCliProcess {
  const child = spawn(options.command, options.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    ...PROCESS_TREE_SPAWN_OPTIONS,
  })
  // 文件描述符耗尽时（EMFILE）错误在下一个 tick 才发出，而 stdio 根本没有创建。先挂上监听器，
  // 否则没等 SDK 拿到进程，这个 error 事件就会带崩整个 Host。
  child.on("error", () => undefined)
  const tree = ownProcessTree(child)
  options.signal.addEventListener("abort", () => void tree.terminate(), { once: true })
  if (options.signal.aborted) void tree.terminate()

  let stderr = ""
  const stderrStream: Readable | null = child.stderr
  stderrStream?.setEncoding("utf8")
  stderrStream?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
  })
  stderrStream?.on("error", () => undefined)

  let exited = false
  let delivered = false
  const deliverExit = (): void => {
    if (delivered) return
    delivered = true
    child.emit(DRAINED_EXIT, child.exitCode, child.signalCode)
    // 等超时才走到这里，说明留下来的进程还占着管道。不能销毁：它下次写 stderr 就会收到 SIGPIPE，
    // 而 agent 可能是有意留下它的。只是不再让这根管道拖住 Host 退出。
    ;(stderrStream as (Readable & { unref?: () => void }) | null)?.unref?.()
  }
  child.once("exit", () => {
    exited = true
    if (stderrStream === null || stderrStream.closed) deliverExit()
    else setTimeout(deliverExit, STDERR_DRAIN_MS)
  })
  // 启动失败时也会有 close，但进程根本没运行过，不能告诉 SDK 它退出了；原因由 error 事件报告。
  stderrStream?.once("close", () => {
    if (exited) deliverExit()
  })
  const sdkEvent = (event: string): string => (event === "exit" ? DRAINED_EXIT : event)

  return {
    tree,
    stderrTail: () => stderr.trim(),
    process: {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      kill: (signal) => tree.signal(signal),
      on: ((event: string, listener: () => void) => {
        child.on(sdkEvent(event), listener)
      }) as SpawnedProcess["on"],
      once: ((event: string, listener: () => void) => {
        child.once(sdkEvent(event), listener)
      }) as SpawnedProcess["once"],
      off: ((event: string, listener: () => void) => {
        child.off(sdkEvent(event), listener)
      }) as SpawnedProcess["off"],
    },
  }
}

/**
 * SDK 接管启动后，退出错误里就不再带 stderr 了；把它补回去，用户才知道 CLI 为什么失败。
 * 只补进程退出的错误：其他错误和 stderr 里的警告没有关系。
 */
export function withCliStderr(message: string, stderrTail: string): string {
  if (!/process (exited with code|terminated by signal)/.test(message)) return message
  if (!stderrTail || message.includes(stderrTail)) return message
  return `${message}: ${stderrTail}`
}

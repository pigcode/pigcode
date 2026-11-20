import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { launchTarget, ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "@pigcode/plugin-sdk/node"

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export type PiRecord = Record<string, unknown>
export function record(value: unknown): PiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRecord)
    : {}
}
export function string(value: unknown) {
  return typeof value === "string" ? value : ""
}

interface Reply {
  command: string
  resolve: (data: PiRecord) => void
  reject: (cause: unknown) => void
}

/** Pi 原生 JSONL 一行一条，只按 LF 切割；消息中的 Unicode 分隔符属于正文。 */
export class PiRpc {
  private readonly child
  private readonly tree
  private readonly stopped = new AbortController()
  private readonly pending = new Map<string, Reply>()
  private readonly listeners = new Set<(value: PiRecord) => void>()
  private closing?: Promise<void>
  get signal() {
    return this.stopped.signal
  }

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const target = launchTarget(command, args)
    if (target.shell) throw new Error("Select an executable or supported Node launcher for Pi")
    this.child = spawn(target.command, target.args, {
      ...PROCESS_TREE_SPAWN_OPTIONS,
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.tree = ownProcessTree(this.child)
    let partial = ""
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      try {
        const lines = chunk.split("\n")
        lines[0] = partial + (lines[0] ?? "")
        partial = lines.pop() ?? ""
        if (partial.length > 16 * 1024 * 1024) throw new Error("Pi RPC record is too large")
        for (const line of lines) {
          if (!line.trim()) continue
          if (line.length > 16 * 1024 * 1024) throw new Error("Pi RPC record is too large")
          this.receive(record(JSON.parse(line)))
        }
      } catch {
        this.end(new Error("Pi returned an invalid RPC record"))
        void this.close()
      }
    })
    this.child.stderr.resume()
    this.child.stdin.on("error", (error) => this.end(error))
    this.child.on("error", (error) => this.end(error))
    this.child.once("exit", (code, signal) =>
      this.end(new Error("Pi exited (" + (signal ?? code) + ")")),
    )
  }

  private end(error: Error) {
    if (this.signal.aborted) return
    this.stopped.abort(error)
    for (const reply of this.pending.values()) reply.reject(error)
    this.pending.clear()
  }

  private receive(value: PiRecord) {
    if (value.type !== "response") {
      for (const listener of this.listeners) listener(value)
      return
    }
    const id = string(value.id),
      reply = this.pending.get(id)
    if (!reply) return
    this.pending.delete(id)
    if (value.success === true && value.command === reply.command) reply.resolve(record(value.data))
    else
      reply.reject(new Error(string(value.error) || "Unexpected Pi response to " + reply.command))
  }

  /** 按请求 id 关联返回值；退出、超时或中断时停止等待。 */
  async request(
    command: string,
    params: PiRecord = {},
    signal?: AbortSignal,
    timeout = 15_000,
  ): Promise<PiRecord> {
    this.signal.throwIfAborted()
    const stop = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ])
    stop.throwIfAborted()
    const id = randomUUID()
    const reply = deferred<PiRecord>()
    this.pending.set(id, { command, ...reply })
    const abort = () => reply.reject(stop.reason)
    stop.addEventListener("abort", abort, { once: true })
    try {
      void this.write({ id, type: command, ...params }).catch(reply.reject)
      return await reply.promise
    } finally {
      stop.removeEventListener("abort", abort)
      this.pending.delete(id)
    }
  }

  write(message: PiRecord) {
    this.signal.throwIfAborted()
    return new Promise<void>((resolve, reject) =>
      this.child.stdin.write(JSON.stringify(message) + "\n", (err) =>
        err ? reject(err) : resolve(),
      ),
    )
  }

  /** 在发送命令前订阅，避免漏掉快速返回的 agent_settled 或扩展注册通知。 */
  async until<T>(onEvent: (event: PiRecord) => T | undefined, signal: AbortSignal): Promise<T> {
    const stop = AbortSignal.any([signal, this.signal])
    stop.throwIfAborted()
    const settled = deferred<T>()
    const receive = (event: PiRecord) => {
      try {
        const result = onEvent(event)
        if (result !== undefined) settled.resolve(result)
      } catch (error) {
        settled.reject(error)
      }
    }
    this.listeners.add(receive)
    const abort = () => settled.reject(stop.reason)
    stop.addEventListener("abort", abort, { once: true })
    try {
      return await settled.promise
    } finally {
      this.listeners.delete(receive)
      stop.removeEventListener("abort", abort)
    }
  }

  close(): Promise<void> {
    return (this.closing ??= this.shutdown())
  }
  private async shutdown() {
    this.end(new Error("Pi RPC closed"))
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = deferred<void>()
      const onExit = () => exited.resolve()
      this.child.once("close", onExit)
      const timeout = setTimeout(onExit, 250)
      this.child.stdin.end()
      try {
        await exited.promise
      } finally {
        clearTimeout(timeout)
        this.child.off("close", onExit)
      }
    }
    await this.tree.terminate()
  }
}

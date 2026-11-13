/** CLI 更新命令的执行与清理，日志交给 Host 展示。 */
import { spawn } from "node:child_process"
import type { AgentCliUpdateRuntime } from "./agent"
import { launchTarget } from "./node"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "./process-tree"

export function runCliUpdate(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  runtime: AgentCliUpdateRuntime,
): Promise<void> {
  runtime.signal.throwIfAborted()
  const target = launchTarget(command, args)
  if (target.shell)
    throw new Error("The updater's batch launcher could not be resolved to an executable.")
  return new Promise((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      ...PROCESS_TREE_SPAWN_OPTIONS,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: target.shell,
    })
    const tree = ownProcessTree(child)
    let failure: Error | null = null
    const stop = (error: Error) => {
      failure = error
      void tree.terminate({ graceMs: 500 })
    }
    const abort = () => stop(new Error("CLI update cancelled"))
    runtime.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => stop(new Error("CLI update timed out")), 5 * 60_000)
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8")
      stream?.on("data", (chunk: string) => runtime.onOutput(chunk))
    }
    const cleanup = () => {
      clearTimeout(timer)
      runtime.signal.removeEventListener("abort", abort)
    }
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("close", (code) => {
      cleanup()
      if (failure) reject(failure)
      else if (code === 0) resolve()
      else reject(new Error(`CLI update exited with code ${code ?? "unknown"}`))
    })
  })
}

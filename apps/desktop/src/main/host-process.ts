/** 启动并监督 Host utilityProcess，分配控制与应用两条 MessageChannel。 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { MessageChannelMain, utilityProcess } from "electron"
import type { MessagePortMain, UtilityProcess } from "electron"

/** 由 main 持有的 Host 子进程与两条端口。 */
export interface HostProcess {
  child: UtilityProcess
  appPort: MessagePortMain
  controlPort: MessagePortMain
  stop(): void
}

/**
 * 追加 Host 输出到 PIGCODE_HOST_LOG。Host 是 utilityProcess，输出默认没有人接管；
 * E2E 把它指到 test-results 下，失败时随 CI 产物一起上传，才能看到 Host 为什么退出。
 * 打不开文件时只报告一次，日志问题不能影响对 Host 的监督。
 */
function createAppender(path: string | undefined): (text: string) => void {
  if (!path) return () => {}
  let created = false
  let failed = false
  return (text) => {
    if (failed) return
    try {
      if (!created) {
        mkdirSync(dirname(path), { recursive: true })
        created = true
      }
      appendFileSync(path, text)
    } catch (error) {
      failed = true
      console.error(`[main] could not write the host log to ${path}:`, error)
    }
  }
}

/**
 * 接管 Host 的 stdout/stderr：stdio 为 pipe 时没人读会把管道写满，Host 会卡在写日志上；
 * 这里转发到 main 自己的输出，并在设置了 PIGCODE_HOST_LOG 时同时写入文件。
 */
function pipeOutput(child: UtilityProcess, append: (text: string) => void): void {
  // 按字符串读取：多字节字符可能被切在两块之间，逐块 toString 会写坏日志里的中文。
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    process.stdout.write(chunk)
    append(chunk)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    process.stderr.write(chunk)
    append(chunk)
  })
}

/** 以 utilityProcess 方式启动 Host，并把端口转交给子进程。 */
export function startHostProcess(entry: string, profileDir: string): HostProcess {
  const control = new MessageChannelMain()
  const app = new MessageChannelMain()
  const child = utilityProcess.fork(entry, [], {
    stdio: "pipe",
    env: { ...process.env, PIGCODE_PROFILE_DIR: profileDir },
  })
  const append = createAppender(process.env.PIGCODE_HOST_LOG)
  // 重启的 Host 追加到同一个文件；分隔线把几次启动的输出分开。
  append(`\n=== host started ${new Date().toISOString()} ===\n`)
  pipeOutput(child, append)
  child.postMessage({ type: "ports" }, [control.port1, app.port1])
  return {
    child,
    controlPort: control.port2,
    appPort: app.port2,
    stop() {
      child.kill()
    },
  }
}

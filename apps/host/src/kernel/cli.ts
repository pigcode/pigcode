/** `pigcode` CLI 入口：保留原有 `--dump-config` 与退出码兼容，并支持完整无窗口运维子命令。 */
import { fileURLToPath } from "node:url"
import { runHeadlessCli } from "./headless-cli"

/** 默认 profile 目录：`apps/host/profiles`（源码与构建产物均可定位）。 */
const defaultProfileDir = fileURLToPath(new URL("../../profiles", import.meta.url))

/** 解析参数并执行 Host CLI；返回进程退出码。 */
export async function runCli(argv: string[]): Promise<number> {
  return runHeadlessCli(argv, {
    stdout: { write: (chunk) => console.log(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk) },
    stderr: { write: (chunk) => console.error(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk) },
    defaultDumpProfileDir: defaultProfileDir,
  })
}

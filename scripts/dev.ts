/**
 * `pnpm dev`：开发模式启动桌面端，改了代码不用手动重新构建。
 *
 * - 界面：electron-vite 起 Vite dev server，main 加载它（ELECTRON_RENDERER_URL），组件改了就热更新。
 * - preload：重新构建后整页刷新；main：重新构建后 electron-vite 重启整个 Electron（`--watch`）。
 * - Host：不归 electron-vite 管，由 build-host.ts 的监听模式重新构建；构建成功后 main 重启 Host，窗口不关。
 *
 * 多余的参数原样交给 `electron-vite dev`，例如 `pnpm dev --remoteDebuggingPort 9222 --inspect 9229`；
 * `--` 之后的交给 Electron，例如 `pnpm dev -- --user-data-dir=/tmp/pigcode-dev`。
 *
 * 退出确认默认关掉（PIGCODE_QUIT_CONFIRM=0，设成 1 可以打开）：electron-vite 用 SIGTERM 结束旧进程，
 * 走的是正常退出流程，有 agent 或终端在跑时旧进程会停在确认框上，新进程等不到单实例锁就退出了。
 */
import { fork, spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const desktopDir = fileURLToPath(new URL("../apps/desktop", import.meta.url))

const env: NodeJS.ProcessEnv = {
  PIGCODE_QUIT_CONFIRM: "0",
  ...process.env,
  PIGCODE_DEV_HOST_WATCH: "1",
}
// 从别的 Electron 应用（编辑器、agent 客户端）里启动时会继承这个变量，Electron 会被当成 Node 跑，窗口出不来。
delete env.ELECTRON_RUN_AS_NODE

const children = new Set<ChildProcess>()
let exiting = false

/** 结束所有子进程后以 code 退出；只做一次。 */
function shutdown(code: number): void {
  if (exiting) return
  exiting = true
  for (const child of children) if (child.exitCode === null) child.kill()
  process.exitCode = code
}

process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))

const hostWatcher = fork(fileURLToPath(new URL("build-host.ts", import.meta.url)), ["--watch"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
})
children.add(hostWatcher)
hostWatcher.once("exit", (code) => {
  if (exiting) return
  console.error(`[dev] the Host watcher exited (${code ?? "signal"})`)
  shutdown(code ?? 1)
})

// Host 首次构建完成前不启动 Electron：main 一启动就加载 out/host 里的 Host。
await new Promise<void>((resolve) => {
  hostWatcher.on("message", (message: { type?: string }) => {
    if (message?.type === "host-ready") resolve()
  })
})

if (!exiting) {
  const electronVite = spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--watch", ...process.argv.slice(2)],
    { cwd: desktopDir, env, stdio: "inherit", shell: process.platform === "win32" },
  )
  children.add(electronVite)
  electronVite.once("exit", (code) => shutdown(code ?? 0))
}

/**
 * `pnpm dev` 的开发模式（scripts/dev.ts）：界面从 Vite dev server 加载，改了就热更新；
 * Host 由 esbuild 监听重新构建，构建完成后 main 重启 Host，窗口不用关。
 * 打包后的应用和 E2E 都不走这里：它们没有这些环境变量，照常加载 out/ 里的构建产物。
 */
import { unwatchFile, watchFile, type Stats } from "node:fs"

/** 构建好的页面；打包后与 E2E 都从这里加载。 */
export const BUILT_RENDERER_URL = "pigcode://app/index.html"

/**
 * 主窗口加载的地址。electron-vite dev 启动 Electron 时把 dev server 地址放在 ELECTRON_RENDERER_URL；
 * 只在没打包时认它，免得装好的应用被一个环境变量带去加载别处的页面。
 */
export function rendererUrl(env: NodeJS.ProcessEnv, isPackaged: boolean): string {
  const devUrl = env.ELECTRON_RENDERER_URL
  return !isPackaged && devUrl ? devUrl : BUILT_RENDERER_URL
}

/** scripts/dev.ts 打开 Host 监听构建时设置；main 据此在构建完成后重启 Host。 */
export function watchesHostBuild(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return !isPackaged && env.PIGCODE_DEV_HOST_WATCH === "1"
}

/** 轮询间隔。标记文件只在保存后写一次，轮询比 fs.watch 在各平台上都可靠。 */
const POLL_MS = 300

/**
 * 盯住 build-host.ts 在每次重新构建成功后改写的标记文件，变了就调用 onBuilt。
 * 启动时已经存在的文件不算一次构建：只有修改时间往后走才触发。返回停止监听的函数。
 */
export function watchHostBuild(markerPath: string, onBuilt: () => void): () => void {
  const listener = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs > previous.mtimeMs) onBuilt()
  }
  watchFile(markerPath, { interval: POLL_MS }, listener)
  return () => unwatchFile(markerPath, listener)
}

/** electron-vite dev 启动的 Electron：改了 main 以后它会结束旧进程、立刻启动新进程。 */
export function restartedByElectronVite(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return rendererUrl(env, isPackaged) !== BUILT_RENDERER_URL
}

/** 开发时等旧进程放开单实例锁的最长时间：旧进程要先停 Host，Host 等 agent 和终端结束最多 3 秒。 */
export const DEV_LOCK_WAIT_MS = 8000

/**
 * 拿单实例锁，拿不到时每隔 intervalMs 再试，直到 waitMs 用完。
 * electron-vite 重启 Electron 时不等旧进程退出：旧进程还在停 Host、没放开锁，新进程这时放弃的话，
 * 两个都会退出，开发会话也跟着结束。打包后 waitMs 是 0，拿不到就让给已经在运行的实例。
 */
export async function acquireInstanceLock(
  request: () => boolean,
  waitMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (request()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

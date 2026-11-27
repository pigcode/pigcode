/**
 * 跨运行时单实例锁（host.lock）与本机控制通道端点解析：
 * 使用临时文件 + fsync + linkSync 原子抢锁，防止桌面端与无窗口后台服务共用同一 profileDir 时并发写库。
 */
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join, posix, resolve, win32 } from "node:path"
import {
  HOST_LOCK_FILE,
  HOST_SOCKET_FILE,
  hostLockMetadataSchema,
  type HostLockMetadata,
  type HostRuntimeKind,
} from "@pigcode/contracts"
import { ensureProfileDir } from "./profile-paths"

/** 产品版本：构建时由 scripts/build-host.ts 与 electron.vite.config.ts 注入，未注入时回退开发版本。 */
declare const __PIGCODE_VERSION__: string | undefined

function defaultHostVersion(): string {
  return typeof __PIGCODE_VERSION__ === "string" ? __PIGCODE_VERSION__ : "0.0.0-dev"
}

/** POSIX `sun_path` 长度上限 104 字节，保留安全余量避免 EINVAL / ENAMETOOLONG。 */
const MAX_POSIX_SOCKET_BYTES = 96
const DEFAULT_CONNECT_TIMEOUT_MS = 400
const MAX_LOCK_ATTEMPTS = 5

/** 已有存活 Host 持有同一 profileDir 锁时抛出的冲突错误。 */
export class HostAlreadyRunningError extends Error {
  readonly owner: HostLockMetadata

  constructor(owner: HostLockMetadata) {
    super(
      `Another Pigcode host (${owner.runtime}, PID ${owner.pid}) is already running for this profile`,
    )
    this.name = "HostAlreadyRunningError"
    this.owner = owner
  }
}

/** 持有单实例锁后的句柄，供退出或启动失败时幂等释放。 */
export interface HostLockHandle {
  readonly lockPath: string
  readonly socketPath: string
  readonly metadata: HostLockMetadata
  release(): void
}

/** `acquireHostLock` 的可选参数。 */
export interface AcquireHostLockOptions {
  runtime: HostRuntimeKind
  version?: string | undefined
  socketPath?: string | undefined
  checkSocket?: ((path: string) => Promise<boolean>) | undefined
  isPidAlive?: ((pid: number) => boolean) | undefined
}

/** `probeLiveHost` 的测试注入钩子。 */
export interface ProbeHostDeps {
  checkSocket?: ((path: string, timeoutMs: number) => Promise<boolean>) | undefined
  isPidAlive?: ((pid: number) => boolean) | undefined
}

/**
 * 解析本机控制通道端点。
 * Windows 使用基于目录哈希的命名管道；POSIX 在路径不超过 96 字节时放在 `<profileDir>/host.sock`，
 * 超出时回退到临时目录的短路径，由 `host.lock` 持久化实际路径供客户端发现。
 */
export function hostControlEndpoint(
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
  fallbackTmpDir: string = tmpdir(),
): string {
  const pathResolve =
    platform === process.platform ? resolve : platform === "win32" ? win32.resolve : posix.resolve
  const pathJoin =
    platform === process.platform ? join : platform === "win32" ? win32.join : posix.join
  const resolved = pathResolve(profileDir)
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16)

  if (platform === "win32") {
    return `\\\\.\\pipe\\pigcode-host-${hash}`
  }

  const direct = pathJoin(resolved, HOST_SOCKET_FILE)
  if (Buffer.byteLength(direct, "utf8") <= MAX_POSIX_SOCKET_BYTES) {
    return direct
  }
  return pathJoin(fallbackTmpDir, `pg-${hash}.sock`)
}

/** 判断指定 PID 当前是否存活（`EPERM` 视为存在，`ESRCH` 视为已退出）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 探测控制通道是否处于活跃监听状态。 */
export function canConnectSocket(
  endpoint: string,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  if (!endpoint) return Promise.resolve(false)
  return new Promise((resolvePromise) => {
    let settled = false
    const socket = createConnection(endpoint)
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(alive)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function readLockFile(lockPath: string): { raw: string; metadata: HostLockMetadata | null } | null {
  let raw: string
  try {
    raw = readFileSync(lockPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const parsed = hostLockMetadataSchema.safeParse(JSON.parse(raw))
    return { raw, metadata: parsed.success ? parsed.data : null }
  } catch {
    return { raw, metadata: null }
  }
}

function writeFullBuffer(fd: number, payload: Buffer): void {
  let offset = 0
  while (offset < payload.length) {
    offset += writeSync(fd, payload, offset, payload.length - offset)
  }
}

function removeStaleLockIfUnchanged(lockPath: string, expectedRaw: string): void {
  const current = readLockFile(lockPath)
  if (!current || current.raw !== expectedRaw) return
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function removeStaleSocketBestEffort(socketPath: string): void {
  if (!socketPath || socketPath.startsWith("\\\\.\\pipe\\")) return
  try {
    rmSync(socketPath, { force: true })
  } catch {
    // 清理陈旧 socket 文件失败时不阻塞抢锁；后续 listen 前还会再次检查。
  }
}

/**
 * 探测 `profileDir` 当前是否有存活的 Host 实例持有 `host.lock`。
 * 同时探测 socket 连通性与 PID 存活，避免 Host 刚拿锁但控制通道尚未 listen 的启动窗口竞态。
 */
export async function probeLiveHost(
  profileDir: string,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
  deps: ProbeHostDeps = {},
): Promise<HostLockMetadata | null> {
  const lockPath = join(resolve(profileDir), HOST_LOCK_FILE)
  const existing = readLockFile(lockPath)
  if (!existing?.metadata) return null

  const checkSocket = deps.checkSocket ?? canConnectSocket
  const checkPid = deps.isPidAlive ?? isProcessAlive
  const alive =
    (await checkSocket(existing.metadata.socketPath, timeoutMs)) || checkPid(existing.metadata.pid)
  return alive ? existing.metadata : null
}

/**
 * 为 `profileDir` 原子获取跨运行时单实例锁。
 * 若检测到已有存活实例则返回 `HostAlreadyRunningError`；若旧锁与旧 socket 已失活则自动清理并接管。
 */
export async function acquireHostLock(
  profileDir: string,
  options: AcquireHostLockOptions,
): Promise<HostLockHandle> {
  const resolved = resolve(profileDir)
  ensureProfileDir(resolved)

  const lockPath = join(resolved, HOST_LOCK_FILE)
  const socketPath = options.socketPath ?? hostControlEndpoint(resolved)
  const checkSocket =
    options.checkSocket ??
    ((endpoint: string) => canConnectSocket(endpoint, DEFAULT_CONNECT_TIMEOUT_MS))
  const checkPid = options.isPidAlive ?? isProcessAlive

  const metadata: HostLockMetadata = {
    pid: process.pid,
    instanceId: randomUUID(),
    runtime: options.runtime,
    socketPath,
    startedAt: Date.now(),
    version: options.version ?? defaultHostVersion(),
  }

  const payload = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  const tmpPath = join(resolved, `${HOST_LOCK_FILE}.${process.pid}.${randomUUID()}.tmp`)

  try {
    const fd = openSync(tmpPath, "wx", 0o600)
    try {
      writeFullBuffer(fd, payload)
      if (process.platform !== "win32") {
        fchmodSync(fd, 0o600)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
      try {
        linkSync(tmpPath, lockPath)
        let released = false
        return {
          lockPath,
          socketPath,
          metadata,
          release() {
            if (released) return
            released = true
            const current = readLockFile(lockPath)
            if (current?.metadata?.instanceId !== metadata.instanceId) return
            try {
              unlinkSync(lockPath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }

      const existing = readLockFile(lockPath)
      if (!existing) continue

      if (existing.metadata) {
        const alive =
          (await checkSocket(existing.metadata.socketPath)) || checkPid(existing.metadata.pid)
        if (alive) {
          throw new HostAlreadyRunningError(existing.metadata)
        }
        // 异步探测期间若其他竞争进程已接管并写入新锁，立即重试，避免误删新实例刚创建的 socket。
        if (readLockFile(lockPath)?.raw !== existing.raw) continue
        removeStaleSocketBestEffort(existing.metadata.socketPath)
      }
      removeStaleLockIfUnchanged(lockPath, existing.raw)
    }

    const latest = readLockFile(lockPath)
    if (latest?.metadata) {
      const alive = (await checkSocket(latest.metadata.socketPath)) || checkPid(latest.metadata.pid)
      if (alive) throw new HostAlreadyRunningError(latest.metadata)
    }
    throw new Error(`Failed to acquire host lock at ${lockPath}`)
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件可能已删或不再存在。
    }
  }
}

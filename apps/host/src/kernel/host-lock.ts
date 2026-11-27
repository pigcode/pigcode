/**
 * 跨运行时单实例锁（host.lock）与本机控制通道端点解析：
 * 使用临时文件 + fsync + linkSync 原子抢锁，防止桌面端与无窗口后台服务共用同一 profileDir 时并发写库。
 */
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
/** 启动宽限期：拿锁后到控制通道 listen 完成前的短窗口内允许仅凭 PID 判活，超时后避免 PID 复用死锁。 */
export const STARTUP_LOCK_GRACE_MS = 15_000

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
  now?: (() => number) | undefined
  graceMs?: number | undefined
}

/** `probeLiveHost` 的测试注入钩子。 */
export interface ProbeHostDeps {
  checkSocket?: ((path: string, timeoutMs: number) => Promise<boolean>) | undefined
  isPidAlive?: ((pid: number) => boolean) | undefined
  now?: (() => number) | undefined
  graceMs?: number | undefined
}

function ensurePrivatePosixFallbackDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe socket fallback directory (not a real directory): ${dir}`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Unsafe socket fallback directory owner: ${dir}`)
  }
  if ((stats.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700)
    const tightened = lstatSync(dir)
    if (
      tightened.isSymbolicLink() ||
      !tightened.isDirectory() ||
      (tightened.mode & 0o777) !== 0o700
    ) {
      throw new Error(`Unsafe socket fallback directory permissions: ${dir}`)
    }
  }
}

/**
 * 解析本机控制通道端点。
 * Windows 使用基于目录哈希的命名管道；POSIX 在路径不超过 96 字节时放在 `<profileDir>/host.sock`，
 * 超出时回退到临时目录的私有用户目录（`0o700`，非符号链接）下的短路径，由 `host.lock` 持久化。
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

  if (platform === "win32") {
    const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16)
    return `\\\\.\\pipe\\pigcode-host-${hash}`
  }

  const direct = pathJoin(resolved, HOST_SOCKET_FILE)
  if (Buffer.byteLength(direct, "utf8") <= MAX_POSIX_SOCKET_BYTES) {
    return direct
  }

  const uid = process.getuid?.() ?? "user"
  const hash12 = createHash("sha256").update(resolved).digest("hex").slice(0, 12)
  const fallbackDir = pathJoin(fallbackTmpDir, `pigcode-${uid}`)
  const fallback = pathJoin(fallbackDir, `p-${hash12}.sock`)
  if (Buffer.byteLength(fallback, "utf8") > MAX_POSIX_SOCKET_BYTES) {
    throw new Error(
      `Control socket path exceeds ${MAX_POSIX_SOCKET_BYTES} UTF-8 bytes: ${fallback}`,
    )
  }
  if (platform === process.platform) {
    ensurePrivatePosixFallbackDir(fallbackDir)
  }
  return fallback
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
      socket.on("error", () => {})
      socket.destroy()
      resolvePromise(alive)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function isLockOwnerAlive(
  metadata: HostLockMetadata,
  timeoutMs: number,
  deps: {
    checkSocket: (endpoint: string, timeoutMs: number) => Promise<boolean>
    isPidAlive: (pid: number) => boolean
    now: () => number
    graceMs: number
  },
): Promise<boolean> {
  if (await deps.checkSocket(metadata.socketPath, timeoutMs)) {
    return true
  }
  if (Math.abs(deps.now() - metadata.startedAt) > deps.graceMs) {
    return false
  }
  return deps.isPidAlive(metadata.pid)
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

function unlinkStalePosixSocketBestEffort(socketPath: string): void {
  if (!socketPath || process.platform === "win32" || socketPath.startsWith("\\\\.\\pipe\\")) return
  try {
    const stats = lstatSync(socketPath)
    if (!stats.isSocket()) return
    const uid = process.getuid?.()
    if (uid !== undefined && stats.uid !== uid) return
    unlinkSync(socketPath)
  } catch {
    // 清理旧 socket 失败时不阻断已持有锁的启动流程。
  }
}

/**
 * 探测 `profileDir` 当前是否有存活的 Host 实例持有 `host.lock`。
 * 优先探测 socket 连通性；仅在启动宽限期内兜底检查 PID 存活，避免旧进程崩溃且 PID 被复用造成死锁。
 */
export async function probeLiveHost(
  profileDir: string,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
  deps: ProbeHostDeps = {},
): Promise<HostLockMetadata | null> {
  const lockPath = join(resolve(profileDir), HOST_LOCK_FILE)
  const existing = readLockFile(lockPath)
  if (!existing?.metadata) return null

  const alive = await isLockOwnerAlive(existing.metadata, timeoutMs, {
    checkSocket: deps.checkSocket ?? canConnectSocket,
    isPidAlive: deps.isPidAlive ?? isProcessAlive,
    now: deps.now ?? Date.now,
    graceMs: deps.graceMs ?? STARTUP_LOCK_GRACE_MS,
  })
  return alive ? existing.metadata : null
}

/**
 * 为 `profileDir` 原子获取跨运行时单实例锁。
 * 若检测到已有存活实例则返回 `HostAlreadyRunningError`；
 * 若旧锁已失活则仅清理旧 `host.lock`，拿到新锁后再清理差异化的旧 socket，避免误删并发竞争者的活跃端点。
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
  const now = options.now ?? Date.now
  const graceMs = options.graceMs ?? STARTUP_LOCK_GRACE_MS

  const metadata: HostLockMetadata = {
    pid: process.pid,
    instanceId: randomUUID(),
    runtime: options.runtime,
    socketPath,
    startedAt: now(),
    version: options.version ?? defaultHostVersion(),
  }

  const payload = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  const tmpPath = join(resolved, `${HOST_LOCK_FILE}.${process.pid}.${randomUUID()}.tmp`)
  const staleSocketCandidates = new Set<string>()

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
        for (const candidate of staleSocketCandidates) {
          if (candidate !== socketPath && !(await checkSocket(candidate))) {
            unlinkStalePosixSocketBestEffort(candidate)
          }
        }
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
        const alive = await isLockOwnerAlive(existing.metadata, DEFAULT_CONNECT_TIMEOUT_MS, {
          checkSocket: (endpoint) => checkSocket(endpoint),
          isPidAlive: checkPid,
          now,
          graceMs,
        })
        if (alive) {
          throw new HostAlreadyRunningError(existing.metadata)
        }
        staleSocketCandidates.add(existing.metadata.socketPath)
      }
      removeStaleLockIfUnchanged(lockPath, existing.raw)
    }

    const latest = readLockFile(lockPath)
    if (latest?.metadata) {
      const alive = await isLockOwnerAlive(latest.metadata, DEFAULT_CONNECT_TIMEOUT_MS, {
        checkSocket: (endpoint) => checkSocket(endpoint),
        isPidAlive: checkPid,
        now,
        graceMs,
      })
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

/** 验证跨运行时单实例锁（host.lock）与本机控制端点路径解析。 */
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, posix, resolve, win32 } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HOST_LOCK_FILE, HOST_SOCKET_FILE, hostLockMetadataSchema } from "@pigcode/contracts"
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import {
  HostAlreadyRunningError,
  STARTUP_LOCK_GRACE_MS,
  acquireHostLock,
  hostControlEndpoint,
  probeLiveHost,
} from "./host-lock"

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(prefix = "pigcode-host-lock-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function getDeadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" })
  if (!result.pid) throw new Error("failed to spawn helper process for dead pid")
  return result.pid
}

function createStalePosixSocket(socketPath: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
      socketPath,
    ],
    { stdio: "ignore" },
  )
  if (result.status !== 0) {
    throw new Error(`failed to create stale unix socket at ${socketPath}`)
  }
}

describe("hostControlEndpoint", () => {
  it("uses <profileDir>/host.sock on POSIX when UTF-8 byte length is within 96 bytes", () => {
    const profileDir = "/tmp/p1"
    expect(hostControlEndpoint(profileDir, "darwin", "/tmp")).toBe(
      posix.join(profileDir, HOST_SOCKET_FILE),
    )
    expect(hostControlEndpoint(profileDir, "linux", "/tmp")).toBe(
      posix.join(profileDir, HOST_SOCKET_FILE),
    )
  })

  it("falls back to per-user 0700 directory under fallbackTmpDir when POSIX direct path exceeds 96 UTF-8 bytes", async () => {
    const longSegment = "中文目录-".repeat(12)
    const profileDir = `/tmp/${longSegment}/profile`
    const expectedHash = createHash("sha256").update(profileDir).digest("hex").slice(0, 12)
    const uid = process.getuid?.() ?? "user"
    const posixEndpoint = hostControlEndpoint(profileDir, "linux", "/tmp/pg-fb")
    expect(posixEndpoint).toBe(posix.join("/tmp/pg-fb", `pigcode-${uid}`, `p-${expectedHash}.sock`))
    expect(Buffer.byteLength(posixEndpoint, "utf8")).toBeLessThanOrEqual(96)

    if (process.platform !== "win32") {
      const fallbackRoot = await makeTempDir("pg-fb-")
      const expectedDir = join(fallbackRoot, `pigcode-${uid}`)
      const endpoint = hostControlEndpoint(profileDir, process.platform, fallbackRoot)

      expect(endpoint).toBe(join(expectedDir, `p-${expectedHash}.sock`))
      expect(Buffer.byteLength(endpoint, "utf8")).toBeLessThanOrEqual(96)
      const dirStat = await lstat(expectedDir)
      expect(dirStat.isDirectory()).toBe(true)
      expect(dirStat.isSymbolicLink()).toBe(false)
      expect(dirStat.mode & 0o777).toBe(0o700)
    }
  })

  it("throws when fallback socket directory is unsafe or total path exceeds 96 bytes", async () => {
    if (process.platform !== "win32") {
      const fallbackRoot = await makeTempDir("pg-unsafe-")
      const realDir = join(fallbackRoot, "real")
      await mkdir(realDir, { recursive: true })
      const uid = process.getuid?.() ?? "user"
      await symlink(realDir, join(fallbackRoot, `pigcode-${uid}`))

      const longProfile = `/tmp/${"a".repeat(100)}/profile`
      expect(() => hostControlEndpoint(longProfile, process.platform, fallbackRoot)).toThrow(
        /unsafe/i,
      )
    }

    const tooLongTmp = `/tmp/${"x".repeat(90)}`
    expect(() =>
      hostControlEndpoint(`/tmp/${"y".repeat(100)}/profile`, "linux", tooLongTmp),
    ).toThrow(/exceeds 96 UTF-8 bytes/i)
  })

  it("uses deterministic Windows named pipe path on win32", () => {
    const profileDir = "C:\\Users\\alice\\AppData\\Roaming\\Pigcode\\profiles\\desktop"
    const resolved = win32.resolve(profileDir)
    const expectedHash = createHash("sha256").update(resolved).digest("hex").slice(0, 16)

    expect(hostControlEndpoint(profileDir, "win32", "C:\\Temp")).toBe(
      `\\\\.\\pipe\\pigcode-host-${expectedHash}`,
    )
  })
})

describe("acquireHostLock", () => {
  it("creates profileDir, writes 0600 host.lock with metadata, and releases idempotently", async () => {
    const root = await makeTempDir()
    const profileDir = join(root, "nested", "profile")

    const lock = await acquireHostLock(profileDir, { runtime: "headless" })
    cleanups.push(() => lock.release())

    expect(lock.lockPath).toBe(join(resolve(profileDir), HOST_LOCK_FILE))
    expect(lock.metadata.pid).toBe(process.pid)
    expect(lock.metadata.runtime).toBe("headless")
    expect(lock.metadata.version).toBe(HOST_VERSION)
    expect(lock.metadata.socketPath).toBe(hostControlEndpoint(profileDir))

    const raw = await readFile(lock.lockPath, "utf8")
    expect(hostLockMetadataSchema.parse(JSON.parse(raw))).toEqual(lock.metadata)

    if (process.platform !== "win32") {
      expect((await stat(profileDir)).mode & 0o777).toBe(0o700)
      expect((await stat(lock.lockPath)).mode & 0o777).toBe(0o600)
    }

    lock.release()
    await expect(readFile(lock.lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(() => lock.release()).not.toThrow()
  })

  it("does not remove another instance's lock when releasing", async () => {
    const profileDir = await makeTempDir()
    const lock = await acquireHostLock(profileDir, { runtime: "desktop" })

    const otherMetadata = {
      pid: process.pid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath: lock.socketPath,
      startedAt: Date.now(),
      version: "1.0.0",
    }
    await writeFile(lock.lockPath, `${JSON.stringify(otherMetadata)}\n`, "utf8")

    lock.release()
    const remaining = hostLockMetadataSchema.parse(
      JSON.parse(await readFile(lock.lockPath, "utf8")),
    )
    expect(remaining.instanceId).toBe(otherMetadata.instanceId)
  })

  it("throws HostAlreadyRunningError when another live PID is within startup grace window", async () => {
    const profileDir = await makeTempDir()
    const nowMs = 1_700_000_000_000
    const lock = await acquireHostLock(profileDir, {
      runtime: "headless",
      version: "0.9.0",
      now: () => nowMs,
    })
    cleanups.push(() => lock.release())

    let caught: unknown
    try {
      await acquireHostLock(profileDir, {
        runtime: "desktop",
        now: () => nowMs + STARTUP_LOCK_GRACE_MS - 100,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HostAlreadyRunningError)
    expect((caught as HostAlreadyRunningError).owner).toEqual(lock.metadata)
  })

  it("reclaims lock with dead socket past startup grace window even if PID appears alive (PID reuse)", async () => {
    const profileDir = await makeTempDir()
    const socketPath = hostControlEndpoint(profileDir)
    const oldStart = 1_700_000_000_000
    const staleReusedPidMeta = {
      pid: process.pid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath,
      startedAt: oldStart,
      version: "0.1.0",
    }
    await writeFile(
      join(profileDir, HOST_LOCK_FILE),
      `${JSON.stringify(staleReusedPidMeta)}\n`,
      "utf8",
    )

    const lock = await acquireHostLock(profileDir, {
      runtime: "desktop",
      now: () => oldStart + STARTUP_LOCK_GRACE_MS + 1,
      isPidAlive: () => true,
    })
    cleanups.push(() => lock.release())
    expect(lock.metadata.instanceId).not.toBe(staleReusedPidMeta.instanceId)
    expect(lock.metadata.runtime).toBe("desktop")
  })

  it("throws HostAlreadyRunningError when socket is live even if PID is dead and past grace window", async () => {
    const profileDir = await makeTempDir()
    const socketPath = hostControlEndpoint(profileDir)
    const server = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(socketPath, () => resolveListen())
    })
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))

    const deadPid = getDeadPid()
    const existing = {
      pid: deadPid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath,
      startedAt: Date.now() - STARTUP_LOCK_GRACE_MS - 60_000,
      version: "0.1.0",
    }
    await writeFile(join(profileDir, HOST_LOCK_FILE), `${JSON.stringify(existing)}\n`, "utf8")

    await expect(acquireHostLock(profileDir, { runtime: "desktop" })).rejects.toBeInstanceOf(
      HostAlreadyRunningError,
    )
  })

  it("defers stale different-socket cleanup until after winning host.lock", async () => {
    const profileDir = await makeTempDir()
    const otherSocketDir = await makeTempDir("pg-old-sock-")
    const oldSocketPath = join(otherSocketDir, "legacy.sock")
    const deadPid = getDeadPid()

    if (process.platform !== "win32") {
      createStalePosixSocket(oldSocketPath)
      expect((await lstat(oldSocketPath)).isSocket()).toBe(true)
    }

    const staleMeta = {
      pid: deadPid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath: oldSocketPath,
      startedAt: Date.now() - 60_000,
      version: "0.0.1",
    }
    await writeFile(join(profileDir, HOST_LOCK_FILE), `${JSON.stringify(staleMeta)}\n`, "utf8")

    const lock = await acquireHostLock(profileDir, { runtime: "desktop" })
    cleanups.push(() => lock.release())

    expect(lock.metadata.instanceId).not.toBe(staleMeta.instanceId)
    if (process.platform !== "win32") {
      await expect(stat(oldSocketPath)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  it("cleans up corrupt host.lock and acquires cleanly", async () => {
    const profileDir = await makeTempDir()
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, HOST_LOCK_FILE), "{broken-json", "utf8")

    const lock = await acquireHostLock(profileDir, { runtime: "headless" })
    cleanups.push(() => lock.release())
    expect(lock.metadata.pid).toBe(process.pid)
  })

  it("resolves concurrent lock race with exactly one winner and one HostAlreadyRunningError", async () => {
    const profileDir = await makeTempDir()
    const results = await Promise.allSettled([
      acquireHostLock(profileDir, { runtime: "desktop" }),
      acquireHostLock(profileDir, { runtime: "headless" }),
    ])

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireHostLock>>> =>
        result.status === "fulfilled",
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )

    for (const item of fulfilled) cleanups.push(() => item.value.release())

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(HostAlreadyRunningError)
  })

  it("does not touch winner's socket when host.lock changes during stale probe", async () => {
    const profileDir = await makeTempDir()
    const socketPath = join(profileDir, "winner.sock")
    const lockPath = join(profileDir, HOST_LOCK_FILE)
    const deadPid = getDeadPid()

    const staleMeta = {
      pid: deadPid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath,
      startedAt: Date.now() - 60_000,
      version: "0.0.1",
    }
    await writeFile(lockPath, `${JSON.stringify(staleMeta)}\n`, "utf8")

    const winnerMeta = {
      pid: process.pid,
      instanceId: randomUUID(),
      runtime: "desktop" as const,
      socketPath,
      startedAt: Date.now(),
      version: "0.1.0",
    }
    let probes = 0
    await expect(
      acquireHostLock(profileDir, {
        runtime: "headless",
        socketPath,
        checkSocket: async () => {
          probes += 1
          if (probes === 1) {
            await writeFile(lockPath, `${JSON.stringify(winnerMeta)}\n`, "utf8")
            await writeFile(socketPath, "winner-socket", "utf8")
            return false
          }
          return true
        },
      }),
    ).rejects.toMatchObject({
      name: "HostAlreadyRunningError",
      owner: winnerMeta,
    })

    expect(await readFile(socketPath, "utf8")).toBe("winner-socket")
    expect(hostLockMetadataSchema.parse(JSON.parse(await readFile(lockPath, "utf8")))).toEqual(
      winnerMeta,
    )
  })
})

describe("probeLiveHost", () => {
  it("returns null when lock is missing or invalid", async () => {
    const profileDir = await makeTempDir()
    await expect(probeLiveHost(profileDir)).resolves.toBeNull()

    await writeFile(join(profileDir, HOST_LOCK_FILE), "not json", "utf8")
    await expect(probeLiveHost(profileDir)).resolves.toBeNull()
  })

  it("respects startup grace window for PID-only liveness and prioritizes live sockets", async () => {
    const profileDir = await makeTempDir()
    const socketPath = hostControlEndpoint(profileDir)
    const deadPid = getDeadPid()
    const baseNow = 1_700_000_000_000

    const deadMeta = {
      pid: deadPid,
      instanceId: randomUUID(),
      runtime: "headless" as const,
      socketPath,
      startedAt: baseNow,
      version: "0.1.0",
    }
    await writeFile(join(profileDir, HOST_LOCK_FILE), `${JSON.stringify(deadMeta)}\n`, "utf8")
    await expect(probeLiveHost(profileDir, 150, { now: () => baseNow })).resolves.toBeNull()

    // 拉起真实监听 socket，即使超出宽限期且 PID 已不存在仍识别为存活
    const server = createServer()
    await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen))
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    await expect(
      probeLiveHost(profileDir, 300, { now: () => baseNow + STARTUP_LOCK_GRACE_MS + 60_000 }),
    ).resolves.toEqual(deadMeta)

    // 关掉 socket 后把 PID 换成存活进程：宽限期内识别为启动期存活，超出宽限期视为旧 PID 复用
    await new Promise<void>((done) => server.close(() => done()))
    const bootingMeta = { ...deadMeta, pid: process.pid }
    await writeFile(join(profileDir, HOST_LOCK_FILE), `${JSON.stringify(bootingMeta)}\n`, "utf8")
    await expect(
      probeLiveHost(profileDir, 150, { now: () => baseNow + STARTUP_LOCK_GRACE_MS - 10 }),
    ).resolves.toEqual(bootingMeta)
    await expect(
      probeLiveHost(profileDir, 150, { now: () => baseNow + STARTUP_LOCK_GRACE_MS + 1 }),
    ).resolves.toBeNull()
  })

  it("supports long profile paths via private fallback socket path in lock metadata", async () => {
    const root = await makeTempDir()
    const longProfile = join(root, "deep-".repeat(25), "profile")
    const lock = await acquireHostLock(longProfile, { runtime: "headless" })
    cleanups.push(() => lock.release())

    expect(Buffer.byteLength(lock.socketPath, "utf8")).toBeLessThanOrEqual(96)
    await expect(probeLiveHost(longProfile)).resolves.toEqual(lock.metadata)
  })
})

/** 验证本机控制通道（host.sock）NDJSON 协议、权限、并发、校验与错误隔离。 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  hostAdminResponseSchema,
  type HostAdminMethod,
  type HostStatusView,
  type MobilePairingView,
} from "@pigcode/contracts"
import {
  AdminClientError,
  AdminHandlerError,
  callAdminSocket,
  startAdminSocketServer,
  type AdminHandlers,
  type AdminSocketServer,
} from "./admin-socket"
import { hostControlEndpoint } from "./host-lock"

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeEndpoint(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-admin-sock-"))
  dirs.push(dir)
  return hostControlEndpoint(dir)
}

function makeHandlers(overrides: Partial<AdminHandlers> = {}): AdminHandlers {
  const emptyPairing: MobilePairingView = {
    status: "idle",
    attempt: null,
    devices: [],
  }
  const emptyDesktopPairing = {
    status: "idle" as const,
    attempt: null,
    clients: [],
  }
  const status: HostStatusView = {
    pid: process.pid,
    runtime: "headless",
    version: "0.1.0-test",
    profileDir: "/tmp/test-profile",
    startedAt: 1_700_000_000_000,
    relay: { address: null, tokenConfigured: false },
    lanAddresses: ["192.168.1.10:39871"],
    activeRuns: 1,
    pendingApprovals: 2,
    pairedDevices: 0,
  }
  return {
    "host.status": () => status,
    "host.setName": ({ name }) => ({ hostName: name }),
    "host.stop": () => ({ stopping: true }),
    "relay.view": () => ({ address: null, tokenConfigured: false }),
    "relay.testAndSave": () => ({
      status: "saved",
      settings: { address: "wss://relay.example/ws/v1/connect", tokenConfigured: true },
    }),
    "relay.clear": () => ({ address: null, tokenConfigured: false }),
    "mobile.pairing.view": () => emptyPairing,
    "mobile.pairing.start": () => ({ ...emptyPairing, status: "waiting" }),
    "mobile.pairing.cancel": () => ({ ...emptyPairing, status: "cancelled" }),
    "mobile.pairing.confirm": () => ({ ...emptyPairing, status: "paired" }),
    "mobile.devices.list": () => [],
    "mobile.devices.revoke": () => ({ status: "missing-device", pairing: emptyPairing }),
    "desktop.pairing.view": () => emptyDesktopPairing,
    "desktop.pairing.start": () => ({ ...emptyDesktopPairing, status: "waiting" }),
    "desktop.pairing.cancel": () => ({ ...emptyDesktopPairing, status: "cancelled" }),
    "desktop.pairing.confirm": () => ({ ...emptyDesktopPairing, status: "paired" }),
    "desktop.devices.list": () => [],
    "desktop.devices.revoke": () => ({
      status: "missing-device",
      pairing: emptyDesktopPairing,
    }),
    ...overrides,
  }
}

async function sendRaw(endpoint: string, payload: string | Buffer): Promise<string> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(endpoint)
    let data = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      data += chunk
      if (data.includes("\n")) {
        socket.end()
        resolveResponse(data.trim())
      }
    })
    socket.once("error", rejectResponse)
    socket.once("close", () => {
      if (data) resolveResponse(data.trim())
      else rejectResponse(new Error("socket closed without response"))
    })
    socket.once("connect", () => {
      socket.write(payload)
    })
  })
}

describe("admin-socket", () => {
  it("starts with 0600 permissions on POSIX, serves typed requests, and removes socket on close", async () => {
    const endpoint = await makeEndpoint()
    const handlers = makeHandlers()
    const server: AdminSocketServer = await startAdminSocketServer(endpoint, handlers)
    cleanups.push(() => server.close())

    if (process.platform !== "win32") {
      expect((await stat(endpoint)).mode & 0o777).toBe(0o600)
    }

    const status = await callAdminSocket(endpoint, "host.status", {})
    expect(status.runtime).toBe("headless")
    expect(status.activeRuns).toBe(1)

    const saved = await callAdminSocket(endpoint, "relay.testAndSave", {
      address: "wss://relay.example/ws/v1/connect",
      token: "secret",
    })
    expect(saved.status).toBe("saved")

    const confirmId = randomUUID()
    const confirmation = randomUUID()
    const paired = await callAdminSocket(endpoint, "mobile.pairing.confirm", {
      id: confirmId,
      confirmation,
    })
    expect(paired.status).toBe("paired")

    await server.close()
    await server.close()
    if (process.platform !== "win32") {
      await expect(stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  it("handles concurrent callers, chunked UTF-8 frames, and half-open writes", async () => {
    const endpoint = await makeEndpoint()
    const pairingStart = vi.fn(async (delayMs: number) => {
      await new Promise((r) => setTimeout(r, delayMs))
    })
    let counter = 0
    const server = await startAdminSocketServer(
      endpoint,
      makeHandlers({
        "host.status": async () => {
          const idx = ++counter
          await pairingStart(idx === 1 ? 30 : 5)
          return {
            pid: process.pid,
            runtime: "headless",
            version: `0.1.${idx}`,
            profileDir: "/tmp/p",
            startedAt: 1,
            relay: { address: null, tokenConfigured: false },
            lanAddresses: [],
            activeRuns: idx,
            pendingApprovals: 0,
            pairedDevices: 0,
          }
        },
        "relay.testAndSave": async (params) => {
          await new Promise((r) => setTimeout(r, 20))
          return {
            status: "saved",
            settings: { address: params.address, tokenConfigured: true },
          }
        },
      }),
    )
    cleanups.push(() => server.close())

    const [first, second] = await Promise.all([
      callAdminSocket(endpoint, "host.status", {}),
      callAdminSocket(endpoint, "host.status", {}),
    ])
    expect([first.activeRuns, second.activeRuns].sort()).toEqual([1, 2])

    // 模拟多字节 UTF-8 被拆分到多个 chunk 且客户端立刻 end() 半关闭写端
    const rawResp = await new Promise<string>((resolveResp, rejectResp) => {
      const socket = createConnection(endpoint)
      const frame = Buffer.from(
        `${JSON.stringify({
          id: "half-open-1",
          method: "relay.testAndSave",
          params: { address: "wss://中继.example/ws/v1/connect", token: "密钥" },
        })}\n`,
        "utf8",
      )
      const splitAt = Math.floor(frame.length / 2)
      let out = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        out += chunk
      })
      socket.once("end", () => resolveResp(out.trim()))
      socket.once("error", rejectResp)
      socket.once("connect", () => {
        socket.write(frame.subarray(0, splitAt))
        setTimeout(() => {
          socket.end(frame.subarray(splitAt))
        }, 10)
      })
    })
    const parsed = hostAdminResponseSchema.parse(JSON.parse(rawResp))
    expect(parsed).toMatchObject({
      id: "half-open-1",
      ok: true,
      result: { status: "saved", settings: { address: "wss://中继.example/ws/v1/connect" } },
    })
  })

  it("rejects malformed JSON, unknown methods, invalid params, and oversized lines without crashing", async () => {
    const endpoint = await makeEndpoint()
    const server = await startAdminSocketServer(
      endpoint,
      makeHandlers({
        "host.stop": () => {
          throw new AdminHandlerError("UNSUPPORTED_RUNTIME", "desktop host cannot stop remotely")
        },
      }),
    )
    cleanups.push(() => server.close())

    const badJson = hostAdminResponseSchema.parse(JSON.parse(await sendRaw(endpoint, "{bad\n")))
    expect(badJson).toMatchObject({ ok: false, code: "INVALID_JSON" })

    const badEnvelope = hostAdminResponseSchema.parse(
      JSON.parse(await sendRaw(endpoint, `${JSON.stringify({ id: "req-1" })}\n`)),
    )
    expect(badEnvelope).toMatchObject({ id: "req-1", ok: false, code: "INVALID_REQUEST" })

    const unknownMethod = hostAdminResponseSchema.parse(
      JSON.parse(
        await sendRaw(endpoint, `${JSON.stringify({ id: "req-2", method: "toString" })}\n`),
      ),
    )
    expect(unknownMethod).toMatchObject({ id: "req-2", ok: false, code: "METHOD_NOT_FOUND" })

    const badParams = hostAdminResponseSchema.parse(
      JSON.parse(
        await sendRaw(
          endpoint,
          `${JSON.stringify({ id: "req-3", method: "mobile.pairing.cancel", params: { id: "not-uuid" } })}\n`,
        ),
      ),
    )
    expect(badParams).toMatchObject({ id: "req-3", ok: false, code: "INVALID_PARAMS" })

    await expect(callAdminSocket(endpoint, "host.stop", {})).rejects.toMatchObject({
      name: "AdminClientError",
      code: "UNSUPPORTED_RUNTIME",
      message: "desktop host cannot stop remotely",
    })

    // 超大行触发保护，服务端不崩且仍能响应后续请求
    const oversized = `${"x".repeat(260 * 1024)}\n`
    const oversizedResp = hostAdminResponseSchema.parse(
      JSON.parse(await sendRaw(endpoint, oversized)),
    )
    expect(oversizedResp).toMatchObject({ ok: false, code: "REQUEST_TOO_LARGE" })

    const afterStatus = await callAdminSocket(endpoint, "host.status", {})
    expect(afterStatus.pid).toBe(process.pid)

    if (process.platform !== "win32") {
      // POSIX socket 下客户端发送无结尾换行符的请求后直接半关闭（EOF）也能得到响应
      // （Windows 命名管道不支持半双工 FIN，client.end 会直接关闭双向句柄）。
      const eofResponse = await new Promise<string>((resolveResp, rejectResp) => {
        const socket = createConnection(endpoint)
        let out = ""
        socket.setEncoding("utf8")
        socket.on("data", (chunk: string) => {
          out += chunk
        })
        socket.once("end", () => resolveResp(out.trim()))
        socket.once("error", rejectResp)
        socket.once("connect", () => {
          socket.end(JSON.stringify({ id: "eof-1", method: "relay.view", params: {} }))
        })
      })
      expect(hostAdminResponseSchema.parse(JSON.parse(eofResponse))).toMatchObject({
        id: "eof-1",
        ok: true,
        result: { address: null, tokenConfigured: false },
      })
    }
  })

  it("refuses to overwrite an active socket or non-socket path, and replaces a real stale socket", async () => {
    const endpoint = await makeEndpoint()
    const first = await startAdminSocketServer(endpoint, makeHandlers())
    cleanups.push(() => first.close())

    await expect(startAdminSocketServer(endpoint, makeHandlers())).rejects.toThrow(
      /already active/i,
    )
    // 原服务不受影响
    expect((await callAdminSocket(endpoint, "host.status", {})).pid).toBe(process.pid)

    await first.close()

    if (process.platform !== "win32") {
      // 普通文件或目录不可被当作陈旧 socket 覆盖
      await writeFile(endpoint, "regular-file", "utf8")
      await expect(startAdminSocketServer(endpoint, makeHandlers())).rejects.toThrow(/non-socket/i)
      await rm(endpoint, { force: true })

      await mkdir(endpoint)
      await expect(startAdminSocketServer(endpoint, makeHandlers())).rejects.toThrow(/non-socket/i)
      await rm(endpoint, { recursive: true, force: true })

      // 模拟进程异常退出残留的真实 Unix socket 文件
      const res = spawnSync(
        process.execPath,
        [
          "-e",
          "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
          endpoint,
        ],
        { stdio: "ignore" },
      )
      expect(res.status).toBe(0)
      expect((await lstat(endpoint)).isSocket()).toBe(true)

      const replacement = await startAdminSocketServer(endpoint, makeHandlers())
      cleanups.push(() => replacement.close())
      expect((await callAdminSocket(endpoint, "host.status", {})).pid).toBe(process.pid)
    }
  })

  it("rejects malformed result payloads and oversized server responses in callAdminSocket", async () => {
    const endpoint = await makeEndpoint()
    const server = await startAdminSocketServer(
      endpoint,
      makeHandlers({
        "host.status": (() => ({ bad: true })) as unknown as AdminHandlers["host.status"],
      }),
    )
    cleanups.push(() => server.close())

    await expect(callAdminSocket(endpoint, "host.status", {})).rejects.toMatchObject({
      name: "AdminClientError",
      code: "INVALID_RESPONSE",
    })

    // 非法返回结构与超长响应行均被客户端拒绝
    const rawEndpoint = await makeEndpoint()
    const oversizedServer = createServer((socket) => {
      socket.once("data", () => {
        socket.write(`${"x".repeat(260 * 1024)}\n`)
      })
    })
    await new Promise<void>((r) => oversizedServer.listen(rawEndpoint, r))
    cleanups.push(() => new Promise<void>((done) => oversizedServer.close(() => done())))

    await expect(callAdminSocket(rawEndpoint, "host.status", {})).rejects.toMatchObject({
      name: "AdminClientError",
      code: "RESPONSE_TOO_LARGE",
    })
  })

  it("rejects with AdminClientError on timeout and unreachable endpoint", async () => {
    const endpoint = await makeEndpoint()
    await expect(callAdminSocket(endpoint, "host.status", {}, 200)).rejects.toBeInstanceOf(
      AdminClientError,
    )

    const server = await startAdminSocketServer(
      endpoint,
      makeHandlers({
        "host.status": () => new Promise(() => {}),
      }),
    )
    cleanups.push(() => server.close())

    await expect(
      callAdminSocket(endpoint, "host.status" as HostAdminMethod, {}, 80),
    ).rejects.toMatchObject({
      name: "AdminClientError",
      code: "TIMEOUT",
    })
  })
})

/** `headless-cli` 测试辅助工具：内存流、信号源、最小运行时 profile 与模拟控制通道。 */
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { HostStatusView, MobilePairingView, PairedDevice } from "@pigcode/contracts"
import { pairedDeviceId } from "../mobile/paired-devices"
import { startAdminSocketServer, type AdminHandlers, type AdminSocketServer } from "./admin-socket"
import { hostControlEndpoint } from "./host-lock"

export interface CapturedIo {
  stdout: { write: (chunk: string) => boolean }
  stderr: { write: (chunk: string) => boolean }
  stdin: PassThrough & { isTTY?: boolean }
  readStdout: () => string
  readStderr: () => string
}

export function createCapturedIo(isTTY = false): CapturedIo {
  let out = ""
  let err = ""
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
  stdin.isTTY = isTTY
  return {
    stdout: {
      write(chunk: string) {
        out += chunk
        return true
      },
    },
    stderr: {
      write(chunk: string) {
        err += chunk
        return true
      },
    },
    stdin,
    readStdout: () => out,
    readStderr: () => err,
  }
}

export class TestSignalSource extends EventEmitter {
  override on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener)
  }

  override off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener)
  }
}

export function makePublicKey(seedByte: number): string {
  return Buffer.alloc(32, seedByte).toString("base64url")
}

export function makePairedDevice(
  seedByte: number,
  name: string,
  platform: "ios" | "android" = "ios",
): PairedDevice {
  return {
    publicKey: makePublicKey(seedByte),
    role: "mobile",
    name,
    platform,
    lastConnectedAt: 1_700_000_000_000,
  }
}

export function makePairingViewDevice(
  device: PairedDevice,
  overrides: Partial<MobilePairingView["devices"][number]> = {},
): MobilePairingView["devices"][number] {
  return {
    id: pairedDeviceId(device.publicKey),
    name: device.name,
    platform: device.platform === "android" ? "android" : "ios",
    lastConnectedAt: device.lastConnectedAt,
    connected: false,
    needsRelayUpdate: false,
    ...overrides,
  }
}

export function makeAdminHandlers(overrides: Partial<AdminHandlers> = {}): AdminHandlers {
  const emptyPairing: MobilePairingView = { status: "idle", attempt: null, devices: [] }
  const emptyDesktopPairing = { status: "idle" as const, attempt: null, clients: [] }
  const status: HostStatusView = {
    pid: process.pid,
    runtime: "headless",
    version: "0.1.0-test",
    profileDir: "/tmp/pigcode-test",
    startedAt: 1_700_000_000_000,
    relay: { address: "wss://relay.example/ws/v1/connect", tokenConfigured: true },
    lanAddresses: ["192.168.1.20:39871"],
    activeRuns: 1,
    pendingApprovals: 2,
    pairedDevices: 0,
  }
  return {
    "host.status": () => status,
    "host.setName": ({ name }) => ({ hostName: name }),
    "host.stop": () => ({ stopping: true }),
    "relay.view": () => status.relay,
    "relay.testAndSave": () => ({ status: "saved", settings: status.relay }),
    "relay.clear": () => ({ address: null, tokenConfigured: false }),
    "mobile.pairing.view": () => emptyPairing,
    "mobile.pairing.start": () => ({
      status: "waiting",
      attempt: {
        id: randomUUID(),
        expiresAt: Date.now() + 180_000,
        qr: JSON.stringify({
          type: "pigcode.pair",
          version: 1,
          address: "wss://relay.example/ws/v1/connect",
          token: "tok",
          computerKey: makePublicKey(9),
          computerName: "dev-mac",
          secret: makePublicKey(8),
          expiresAt: Date.now() + 180_000,
        }),
        candidate: null,
      },
      devices: [],
    }),
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

export async function startFixtureAdminServer(
  profileDir: string,
  overrides: Partial<AdminHandlers> = {},
): Promise<{ socketPath: string; server: AdminSocketServer }> {
  const socketPath = hostControlEndpoint(profileDir)
  const server = await startAdminSocketServer(socketPath, makeAdminHandlers(overrides))
  return { socketPath, server }
}

/** 创建可运行 `bootstrapHostKernel` 的最小运行时 profile 目录。 */
export async function writeMinimalRuntimeProfile(runtimeRoot: string): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    join(runtimeRoot, "fixture-services.mjs"),
    [
      "export function createStorage(ctx) {",
      '  ctx.provide("storage", { db: {}, events: {}, receipts: {} })',
      "}",
      "export function createSettings(ctx) {",
      "  const map = new Map()",
      '  ctx.provide("settings", {',
      "    get: (k) => map.get(k),",
      "    set: (k, v) => (v === undefined ? map.delete(k) : map.set(k, v)),",
      "    snapshot: () => Object.fromEntries(map),",
      "    onChange: () => () => undefined,",
      "  })",
      "}",
      "export function createCoreRest(ctx) {",
      '  ctx.provide("projects", { list: () => [] })',
      '  ctx.provide("threads", { get: () => undefined })',
      '  ctx.provide("sessions", { subscribeAll: () => () => undefined })',
      '  ctx.provide("attachments", {})',
      "}",
      "export function createAgents(ctx) {",
      '  ctx.provide("agents", {',
      "    recoverAfterRestart: () => undefined,",
      "    listPendingRequests: () => [],",
      "    listRuns: () => [],",
      '    getRunStatus: () => "completed",',
      "  })",
      "}",
      "export function createSchedules(ctx) {",
      '  ctx.provide("schedules", { start: () => undefined, list: () => [] })',
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
  const wrappers: Array<[string, string]> = [
    ["settings.mjs", "createSettings"],
    ["storage.mjs", "createStorage"],
    ["rest.mjs", "createCoreRest"],
    ["agents.mjs", "createAgents"],
    ["schedules.mjs", "createSchedules"],
  ]
  await Promise.all(
    wrappers.map(([file, fn]) =>
      writeFile(
        join(runtimeRoot, file),
        `export { ${fn} as apply } from "./fixture-services.mjs"\n`,
        "utf8",
      ),
    ),
  )
  await writeFile(
    join(runtimeRoot, "desktop.yml"),
    [
      "plugins:",
      "  - id: core.settings",
      "    name: ./settings.mjs",
      "  - id: core.storage",
      "    name: ./storage.mjs",
      "  - id: core.rest",
      "    name: ./rest.mjs",
      "  - id: core.agents",
      "    name: ./agents.mjs",
      "  - id: core.schedules",
      "    name: ./schedules.mjs",
      "",
    ].join("\n"),
    "utf8",
  )
}

export async function createTempDirs(): Promise<{
  makeDir: (prefix?: string) => Promise<string>
  cleanup: () => Promise<void>
}> {
  const dirs: string[] = []
  return {
    async makeDir(prefix = "pigcode-headless-cli-") {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
    async cleanup() {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    },
  }
}

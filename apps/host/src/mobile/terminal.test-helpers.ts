import { randomUUID } from "node:crypto"
import { Context } from "cordis"
import { expect } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import {
  apply as terminal,
  type PtyFactory,
  type PtyLike,
  type PtySpawnInput,
} from "../services/terminal"
import { apply as threads } from "../services/threads"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

export const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
export const NOISE_TAG_BYTES = 16

export function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

export interface FakePtyInstance {
  input: PtySpawnInput
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  emit(data: string): void
  exit(code: number): void
}

export function createFakePtyFactory() {
  const instances: FakePtyInstance[] = []
  const factory: PtyFactory = {
    spawn(input) {
      let dataListener: ((data: string) => void) | undefined
      let exitListener: ((info: { exitCode: number }) => void) | undefined
      const record: FakePtyInstance = {
        input,
        writes: [],
        resizes: [],
        killed: false,
        emit(data: string) {
          dataListener?.(data)
        },
        exit(code: number) {
          exitListener?.({ exitCode: code })
        },
      }
      instances.push(record)
      const pty: PtyLike = {
        onData(listener) {
          dataListener = listener
        },
        onExit(listener) {
          exitListener = listener
        },
        write(data) {
          record.writes.push(data)
        },
        resize(cols, rows) {
          record.resizes.push({ cols, rows })
        },
        kill() {
          record.killed = true
        },
      }
      return pty
    },
  }
  return { factory, instances }
}

export interface TerminalClientHandle {
  deviceKey: string
  wire: MemoryTransport
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

export async function setupTerminalHost(ptyFactory: PtyFactory, scrollbackBytes?: number) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  await ctx.plugin(terminal, {
    ptyFactory,
    ...(scrollbackBytes !== undefined ? { scrollbackBytes } : {}),
  })

  const feed = new ThreadFeed(ctx)
  const devices = new PairedDevices(ctx.settings)
  const clients: TerminalClientHandle[] = []

  function connectDevice(
    name: string,
    keyByte: number,
    features: readonly string[],
  ): TerminalClientHandle {
    const deviceKey = Buffer.alloc(32, keyByte).toString("base64url")
    if (!devices.find(deviceKey)) {
      devices.save({ publicKey: deviceKey, name, platform: "ios", lastConnectedAt: 1000 })
    }
    const wire = new MemoryTransport()
    const replies = new Map<string, (message: unknown) => void>()
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    wire.client.onMessage((message) => {
      assertSingleNoiseFrame(message)
      const record = message as { id?: string; method?: string; params?: Record<string, unknown> }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
        return
      }
      if (!record.id && typeof record.method === "string") {
        notifications.push({ method: record.method, params: record.params ?? {} })
      }
    })
    const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
      computerKey: Buffer.alloc(32, 1),
      computerName: "测试电脑",
      deviceKey,
      features,
      relayRevision: () => undefined,
    })
    mobile.start()

    const handle: TerminalClientHandle = {
      deviceKey,
      wire,
      notifications,
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        assertSingleNoiseFrame(request)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        return (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
      },
      stop() {
        mobile.stop()
      },
    }
    clients.push(handle)
    return handle
  }

  return {
    ctx,
    devices,
    connectDevice,
    async dispose() {
      for (const client of clients) client.stop()
      await ctx.fiber.dispose()
    },
  }
}

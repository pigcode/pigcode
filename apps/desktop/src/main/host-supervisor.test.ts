import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HostProcess } from "./host-process"
import { createHostSupervisor, type HostSupervisorOptions } from "./host-supervisor"

/** 假 Host：exit() 模拟进程退出；stop() 像真的一样，让进程退出后完成。 */
interface FakeHost extends HostProcess {
  exit(): void
  stops: number
}

function fakeHost(): FakeHost {
  const child = new EventEmitter()
  const host = {
    child,
    controlPort: {},
    connectPage: () => ({}),
    stops: 0,
    exit() {
      child.emit("exit", 0)
    },
    stop() {
      host.stops += 1
      host.exit()
      return Promise.resolve()
    },
  }
  return host as unknown as FakeHost
}

function setup(overrides: Partial<HostSupervisorOptions> = {}) {
  const spawned: FakeHost[] = []
  const onStart = vi.fn()
  const onGiveUp = vi.fn()
  let quitting = false
  const supervisor = createHostSupervisor({
    entry: "/app/out/host/index.mjs",
    profileDir: () => "/profile",
    quitting: () => quitting,
    onStart,
    onGiveUp,
    spawn: () => {
      const host = fakeHost()
      spawned.push(host)
      return host
    },
    ...overrides,
  })
  return { supervisor, spawned, onStart, onGiveUp, quit: () => (quitting = true) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createHostSupervisor", () => {
  it("hands every new Host to onStart", () => {
    const { supervisor, spawned, onStart } = setup()
    supervisor.start()
    expect(onStart).toHaveBeenCalledWith(spawned[0])
    expect(supervisor.current).toBe(spawned[0])
    expect(supervisor.controlPort).toBe(spawned[0]!.controlPort)
  })

  it("backs off after a quick crash and gives up after five", () => {
    const { supervisor, spawned, onGiveUp } = setup()
    supervisor.start()
    for (let i = 0; i < 4; i += 1) {
      spawned.at(-1)!.exit()
      expect(supervisor.controlPort).toBeUndefined()
      vi.runOnlyPendingTimers()
    }
    expect(spawned).toHaveLength(5)
    spawned.at(-1)!.exit()
    expect(onGiveUp).toHaveBeenCalledWith(5, null)
    expect(supervisor.current).toBeUndefined()
  })

  it("restarts at once after a reload, without counting a failure", () => {
    const { supervisor, spawned, onGiveUp } = setup()
    supervisor.start()
    for (let i = 0; i < 10; i += 1) {
      supervisor.reload()
      vi.advanceTimersByTime(0)
    }
    expect(spawned).toHaveLength(11)
    expect(spawned.slice(0, 10).every((host) => host.stops === 1)).toBe(true)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it("starts the new build at once while a crashed Host waits for its retry", () => {
    const { supervisor, spawned } = setup()
    supervisor.start()
    spawned[0]!.exit()
    supervisor.reload()
    expect(spawned).toHaveLength(2)
    // 退避定时器已经取消，不会再多起一个 Host。
    vi.runAllTimers()
    expect(spawned).toHaveLength(2)
  })

  it("starts again after giving up", () => {
    const { supervisor, spawned } = setup()
    supervisor.start()
    for (let i = 0; i < 5; i += 1) {
      spawned.at(-1)!.exit()
      vi.runOnlyPendingTimers()
    }
    expect(supervisor.current).toBeUndefined()
    supervisor.reload()
    expect(supervisor.current).toBe(spawned.at(-1))
    expect(spawned).toHaveLength(6)
  })

  it("does not restart while the app quits", () => {
    const { supervisor, spawned, quit } = setup()
    supervisor.start()
    quit()
    supervisor.reload()
    spawned[0]!.exit()
    vi.runAllTimers()
    expect(spawned).toHaveLength(1)
  })
})

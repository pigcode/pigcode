import { EventEmitter } from "node:events"
import { powerMonitor, powerSaveBlocker } from "electron"
import { expect, it, vi } from "vitest"
import type { HostProcess } from "./host-process"
import { monitorPower, setKeepAwake, watchHostActivity } from "./keep-awake"

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: vi.fn() }),
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
  }
})

it("blocks idle sleep only for an active run on AC and forwards actual suspend and resume", () => {
  const onBattery = vi.mocked(powerMonitor.isOnBatteryPower)
  onBattery.mockReturnValue(true)
  const controlPort = Object.assign(new EventEmitter(), { start: vi.fn() })
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  const activity = (running: boolean) => controlPort.emit("message", { data: { type: "host.running", running } })
  monitorPower()
  watchHostActivity({ controlPort, child } as unknown as HostProcess)

  activity(true)
  expect(powerSaveBlocker.start).not.toHaveBeenCalled()
  onBattery.mockReturnValue(false)
  powerMonitor.emit("on-ac")
  expect(powerSaveBlocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension")
  activity(true)
  expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1)

  powerMonitor.emit("suspend")
  expect(child.postMessage).toHaveBeenLastCalledWith({ type: "power", suspended: true })
  expect(powerSaveBlocker.stop).toHaveBeenCalledWith(1)
  powerMonitor.emit("resume")
  expect(child.postMessage).toHaveBeenLastCalledWith({ type: "power", suspended: false })
  expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2)

  onBattery.mockReturnValue(true)
  powerMonitor.emit("on-battery")
  expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(2)
  setKeepAwake(true)
  expect(powerSaveBlocker.start).toHaveBeenCalledTimes(3)
  child.emit("exit", 0)
  activity(true)
  setKeepAwake(false)
  expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(3)
})

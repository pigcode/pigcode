import { DESKTOP_RPC_MAX_BYTES } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { FrameAssembler, mobileFrames } from "./mobile-frames"

describe("mobileFrames and FrameAssembler", () => {
  it("passes small JSON payloads directly without fragment header", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { ok: true } }
    const frames = [...mobileFrames(payload)]
    expect(frames).toHaveLength(1)
    expect(frames[0]![0]).not.toBe(0x00)
    const assembler = new FrameAssembler()
    expect(assembler.push(frames[0]!)).toEqual({ complete: true, message: payload })
  })

  it("fragments and reassembles multi-megabyte desktop RPC payloads", () => {
    const payload = {
      jsonrpc: "2.0",
      id: "big",
      result: { text: "x".repeat(420_000) },
    }
    const frames = [...mobileFrames(payload, DESKTOP_RPC_MAX_BYTES)]
    expect(frames.length).toBeGreaterThan(6)
    const assembler = new FrameAssembler(DESKTOP_RPC_MAX_BYTES)
    for (let i = 0; i < frames.length - 1; i += 1) {
      expect(assembler.push(frames[i]!)).toEqual({ complete: false })
    }
    expect(assembler.push(frames.at(-1)!)).toEqual({ complete: true, message: payload })
  })

  it("rejects out-of-order or oversized fragments and resets cleanly", () => {
    const payload = { big: "y".repeat(90_000) }
    const frames = [...mobileFrames(payload, DESKTOP_RPC_MAX_BYTES)]
    const assembler = new FrameAssembler(DESKTOP_RPC_MAX_BYTES)
    expect(() => assembler.push(frames[1]!)).toThrow("out-of-order fragment offset")
    expect(() => [...mobileFrames({ huge: "z".repeat(300_000) })]).toThrow(
      "Oversized framed message",
    )
  })
})

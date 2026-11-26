import { describe, expect, it } from "vitest"
import {
  MOBILE_TERMINAL_COLS_MAX,
  MOBILE_TERMINAL_COLS_MIN,
  MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES,
  MOBILE_TERMINAL_ROWS_MAX,
  MOBILE_TERMINAL_ROWS_MIN,
  MOBILE_TERMINAL_WRITE_MAX_BYTES,
  mobileFeatures,
  mobileTerminalAttachParams,
  mobileTerminalAttachResult,
  mobileTerminalCloseParams,
  mobileTerminalDetachParams,
  mobileTerminalExitNotification,
  mobileTerminalListParams,
  mobileTerminalMethods,
  mobileTerminalNotifications,
  mobileTerminalOpenParams,
  mobileTerminalOutputNotification,
  mobileTerminalResizeParams,
  mobileTerminalSummarySchema,
  mobileTerminalWriteParams,
} from "./index"

describe("mobile terminal contracts", () => {
  it("exposes terminal feature and all 7 RPC methods + 2 notifications", () => {
    expect(mobileFeatures).toContain("terminal")
    expect(Object.values(mobileTerminalMethods)).toEqual([
      "mobile.terminal.list",
      "mobile.terminal.open",
      "mobile.terminal.attach",
      "mobile.terminal.detach",
      "mobile.terminal.write",
      "mobile.terminal.resize",
      "mobile.terminal.close",
    ])
    expect(Object.values(mobileTerminalNotifications)).toEqual([
      "mobile.terminal.output",
      "mobile.terminal.exit",
    ])
  })

  it("validates terminal size bounds, cursors, and strict summary without absolute cwd", () => {
    expect(
      mobileTerminalOpenParams.parse({
        threadId: "th_1",
        cols: MOBILE_TERMINAL_COLS_MIN,
        rows: MOBILE_TERMINAL_ROWS_MIN,
      }),
    ).toEqual({ threadId: "th_1", cols: 20, rows: 5 })

    expect(
      mobileTerminalOpenParams.safeParse({
        threadId: "th_1",
        cols: MOBILE_TERMINAL_COLS_MIN - 1,
        rows: 24,
      }).success,
    ).toBe(false)
    expect(
      mobileTerminalResizeParams.safeParse({
        terminalId: "term_1",
        cols: MOBILE_TERMINAL_COLS_MAX + 1,
        rows: 24,
      }).success,
    ).toBe(false)
    expect(
      mobileTerminalResizeParams.safeParse({
        terminalId: "term_1",
        cols: 80,
        rows: MOBILE_TERMINAL_ROWS_MAX + 1,
      }).success,
    ).toBe(false)

    expect(
      mobileTerminalAttachParams.safeParse({
        threadId: "th_1",
        terminalId: "term_1",
        afterCursor: -1,
      }).success,
    ).toBe(false)

    const validSummary = {
      id: "term_1",
      threadId: "th_1",
      shell: "zsh",
      cwdLabel: "pigcode",
      cols: 48,
      rows: 24,
      cursor: 128,
      origin: "mobile",
      writable: true,
      createdAt: "2026-11-26T00:00:00.000Z",
    }
    expect(mobileTerminalSummarySchema.parse(validSummary)).toEqual(validSummary)
    // Rejects unexpected absolute cwd field
    expect(
      mobileTerminalSummarySchema.safeParse({ ...validSummary, cwd: "/Users/dev/pigcode" }).success,
    ).toBe(false)

    expect(
      mobileTerminalAttachResult.parse({
        terminal: validSummary,
        cursor: 128,
        replayChunks: 2,
        truncated: false,
      }),
    ).toMatchObject({ replayChunks: 2, truncated: false })

    expect(mobileTerminalListParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobileTerminalDetachParams.parse({ terminalId: "term_1" })).toEqual({
      terminalId: "term_1",
    })
    expect(mobileTerminalCloseParams.parse({ terminalId: "term_1" })).toEqual({
      terminalId: "term_1",
    })
  })

  it("enforces base64 write and output payload limits", () => {
    const exactWrite = Buffer.alloc(MOBILE_TERMINAL_WRITE_MAX_BYTES, 0x61).toString("base64")
    const overWrite = Buffer.alloc(MOBILE_TERMINAL_WRITE_MAX_BYTES + 1, 0x61).toString("base64")
    expect(
      mobileTerminalWriteParams.safeParse({ terminalId: "term_1", dataBase64: exactWrite }).success,
    ).toBe(true)
    expect(
      mobileTerminalWriteParams.safeParse({ terminalId: "term_1", dataBase64: overWrite }).success,
    ).toBe(false)
    expect(
      mobileTerminalWriteParams.safeParse({ terminalId: "term_1", dataBase64: "" }).success,
    ).toBe(false)
    expect(
      mobileTerminalWriteParams.safeParse({ terminalId: "term_1", dataBase64: "not-base64!" })
        .success,
    ).toBe(false)

    const exactOut = Buffer.alloc(MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES, 0x62).toString("base64")
    const overOut = Buffer.alloc(MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES + 1, 0x62).toString("base64")
    expect(
      mobileTerminalOutputNotification.safeParse({
        terminalId: "term_1",
        dataBase64: exactOut,
        cursor: 24576,
        replay: true,
      }).success,
    ).toBe(true)
    expect(
      mobileTerminalOutputNotification.safeParse({
        terminalId: "term_1",
        dataBase64: "",
        cursor: 24576,
        overflow: true,
      }).success,
    ).toBe(true)
    expect(
      mobileTerminalOutputNotification.safeParse({
        terminalId: "term_1",
        dataBase64: overOut,
        cursor: 24577,
      }).success,
    ).toBe(false)
    expect(
      mobileTerminalExitNotification.parse({ terminalId: "term_1", exitCode: 0 }),
    ).toEqual({ terminalId: "term_1", exitCode: 0 })
  })
})

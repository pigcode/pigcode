/** 手机端远程终端协议定义：发现、新建、游标分片附着、输入输出与电脑终端只读隔离。 */
import { z } from "zod"

export const MOBILE_TERMINAL_MAX_PER_THREAD = 6
export const MOBILE_TERMINAL_COLS_MIN = 20
export const MOBILE_TERMINAL_COLS_MAX = 500
export const MOBILE_TERMINAL_ROWS_MIN = 5
export const MOBILE_TERMINAL_ROWS_MAX = 200
export const MOBILE_TERMINAL_WRITE_MAX_BYTES = 16 * 1024
export const MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES = 24 * 1024
export const MOBILE_TERMINAL_COALESCE_MS = 16
export const MOBILE_TERMINAL_MAX_PENDING_BYTES = 512 * 1024

const MOBILE_TERMINAL_WRITE_BASE64_MAX = Math.ceil(MOBILE_TERMINAL_WRITE_MAX_BYTES / 3) * 4
const MOBILE_TERMINAL_OUTPUT_BASE64_MAX = Math.ceil(MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES / 3) * 4

export const mobileTerminalMethods = {
  list: "mobile.terminal.list",
  open: "mobile.terminal.open",
  attach: "mobile.terminal.attach",
  detach: "mobile.terminal.detach",
  write: "mobile.terminal.write",
  resize: "mobile.terminal.resize",
  close: "mobile.terminal.close",
} as const

export const mobileTerminalNotifications = {
  output: "mobile.terminal.output",
  exit: "mobile.terminal.exit",
} as const

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

const key = z.string().min(1).max(128)
const colsSchema = z.number().int().min(MOBILE_TERMINAL_COLS_MIN).max(MOBILE_TERMINAL_COLS_MAX)
const rowsSchema = z.number().int().min(MOBILE_TERMINAL_ROWS_MIN).max(MOBILE_TERMINAL_ROWS_MAX)

const writeDataBase64Schema = z
  .string()
  .min(1)
  .max(MOBILE_TERMINAL_WRITE_BASE64_MAX)
  .refine(
    (value) =>
      isValidBase64(value) &&
      decodedBase64Bytes(value) >= 1 &&
      decodedBase64Bytes(value) <= MOBILE_TERMINAL_WRITE_MAX_BYTES,
    { message: "dataBase64 must be valid non-empty base64 with decoded size <= 16 KiB" },
  )

const outputDataBase64Schema = z
  .string()
  .max(MOBILE_TERMINAL_OUTPUT_BASE64_MAX)
  .refine(
    (value) =>
      (value.length === 0 || isValidBase64(value)) &&
      decodedBase64Bytes(value) <= MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES,
    { message: "dataBase64 must be valid base64 with decoded size <= 24 KiB" },
  )

export const mobileTerminalOriginSchema = z.enum(["desktop", "mobile"])
export type MobileTerminalOrigin = z.infer<typeof mobileTerminalOriginSchema>

/** 手机端终端摘要：只返回安全目录名 cwdLabel，不暴露电脑绝对路径。 */
export const mobileTerminalSummarySchema = z
  .object({
    id: key,
    threadId: key,
    shell: z.string().min(1).max(80),
    cwdLabel: z.string().min(1).max(120),
    cols: z.number().int().min(1),
    rows: z.number().int().min(1),
    cursor: z.number().int().min(0),
    origin: mobileTerminalOriginSchema,
    writable: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict()

export const mobileTerminalListParams = z.object({ threadId: key }).strict()
export const mobileTerminalListResult = z
  .object({
    terminals: z.array(mobileTerminalSummarySchema),
  })
  .strict()

export const mobileTerminalOpenParams = z
  .object({
    threadId: key,
    cols: colsSchema,
    rows: rowsSchema,
  })
  .strict()
export const mobileTerminalOpenResult = z
  .object({
    terminal: mobileTerminalSummarySchema,
  })
  .strict()

export const mobileTerminalAttachParams = z
  .object({
    threadId: key,
    terminalId: key,
    afterCursor: z.number().int().min(0).optional(),
    cols: colsSchema.optional(),
    rows: rowsSchema.optional(),
  })
  .strict()
export const mobileTerminalAttachResult = z
  .object({
    terminal: mobileTerminalSummarySchema,
    cursor: z.number().int().min(0),
    replayChunks: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict()

export const mobileTerminalDetachParams = z.object({ terminalId: key }).strict()
export const mobileTerminalDetachResult = z.object({ ok: z.literal(true) }).strict()

export const mobileTerminalWriteParams = z
  .object({
    terminalId: key,
    dataBase64: writeDataBase64Schema,
  })
  .strict()
export const mobileTerminalWriteResult = z.object({ ok: z.literal(true) }).strict()

export const mobileTerminalResizeParams = z
  .object({
    terminalId: key,
    cols: colsSchema,
    rows: rowsSchema,
  })
  .strict()
export const mobileTerminalResizeResult = z
  .object({
    cols: colsSchema,
    rows: rowsSchema,
  })
  .strict()

export const mobileTerminalCloseParams = z.object({ terminalId: key }).strict()
export const mobileTerminalCloseResult = z.object({ closed: z.literal(true) }).strict()

export const mobileTerminalOutputNotification = z
  .object({
    terminalId: key,
    dataBase64: outputDataBase64Schema,
    cursor: z.number().int().min(0),
    replay: z.boolean().optional(),
    overflow: z.boolean().optional(),
  })
  .strict()

export const mobileTerminalExitNotification = z
  .object({
    terminalId: key,
    exitCode: z.number().int(),
  })
  .strict()

export type MobileTerminalSummary = z.infer<typeof mobileTerminalSummarySchema>
export type MobileTerminalListParams = z.infer<typeof mobileTerminalListParams>
export type MobileTerminalListResult = z.infer<typeof mobileTerminalListResult>
export type MobileTerminalOpenParams = z.infer<typeof mobileTerminalOpenParams>
export type MobileTerminalOpenResult = z.infer<typeof mobileTerminalOpenResult>
export type MobileTerminalAttachParams = z.infer<typeof mobileTerminalAttachParams>
export type MobileTerminalAttachResult = z.infer<typeof mobileTerminalAttachResult>
export type MobileTerminalDetachParams = z.infer<typeof mobileTerminalDetachParams>
export type MobileTerminalDetachResult = z.infer<typeof mobileTerminalDetachResult>
export type MobileTerminalWriteParams = z.infer<typeof mobileTerminalWriteParams>
export type MobileTerminalWriteResult = z.infer<typeof mobileTerminalWriteResult>
export type MobileTerminalResizeParams = z.infer<typeof mobileTerminalResizeParams>
export type MobileTerminalResizeResult = z.infer<typeof mobileTerminalResizeResult>
export type MobileTerminalCloseParams = z.infer<typeof mobileTerminalCloseParams>
export type MobileTerminalCloseResult = z.infer<typeof mobileTerminalCloseResult>
export type MobileTerminalOutputNotification = z.infer<typeof mobileTerminalOutputNotification>
export type MobileTerminalExitNotification = z.infer<typeof mobileTerminalExitNotification>

/** 跨桌面端互连（Desktop-to-Desktop / Desktop-to-Headless）配对协议与口令编解码。 */
import { z } from "zod"
import {
  computerIdSchema,
  desktopPlatformSchema,
  pairingCodeSchema,
  publicKeySchema,
} from "./mobile"

export const DESKTOP_PAIRING_LINK_PREFIX = "pigcode://pair"
export const DESKTOP_RPC_MAX_BYTES = 16 * 1024 * 1024

export const desktopPairingPayloadSchema = z
  .object({
    type: z.literal("pigcode.desktopPair"),
    version: z.literal(1),
    address: z.url({ protocol: /^wss$/ }).max(4096).nullable(),
    token: z.string().min(1).max(4096).nullable(),
    lanAddresses: z
      .array(z.url({ protocol: /^ws$/ }).max(256))
      .max(8)
      .optional(),
    hostKey: publicKeySchema,
    hostName: z.string().min(1).max(80),
    secret: publicKeySchema,
    expiresAt: z.number().int(),
  })
  .refine(
    (value) =>
      (value.address !== null && value.token !== null) ||
      (value.lanAddresses !== undefined && value.lanAddresses.length > 0),
    {
      message: "desktop pairing payload requires relay credentials or lanAddresses",
    },
  )

export type DesktopPairingPayload = z.infer<typeof desktopPairingPayloadSchema>

export const desktopAuthorizedClientSchema = z.object({
  id: computerIdSchema,
  name: z.string().min(1).max(80),
  platform: desktopPlatformSchema,
  lastConnectedAt: z.number().int().nullable(),
  connected: z.boolean(),
})

export type DesktopAuthorizedClient = z.infer<typeof desktopAuthorizedClientSchema>

export const desktopPairingViewSchema = z.object({
  status: z.enum([
    "idle",
    "connecting",
    "waiting",
    "verify",
    "paired",
    "expired",
    "cancelled",
    "relay-unavailable",
    "needs-relay",
    "storage-unavailable",
  ]),
  attempt: z
    .object({
      id: z.uuid(),
      expiresAt: z.number().int(),
      link: z.string().nullable(),
      lanAddresses: z.array(z.string()),
      candidate: z
        .object({
          confirmation: z.uuid(),
          code: z.string(),
          name: z.string(),
          platform: desktopPlatformSchema,
        })
        .nullable(),
    })
    .nullable(),
  clients: z.array(desktopAuthorizedClientSchema),
})

export type DesktopPairingView = z.infer<typeof desktopPairingViewSchema>

export const desktopRevokeResultSchema = z.object({
  status: z.enum(["revoked", "missing-device", "storage-unavailable"]),
  pairing: desktopPairingViewSchema,
})

export type DesktopRevokeResult = z.infer<typeof desktopRevokeResultSchema>

export type ParseDesktopPairingResult =
  | { ok: true; payload: DesktopPairingPayload }
  | { ok: false; code: "empty" | "mobile-only" | "invalid" }

function encodeUtf8ToBase64Url(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64url")
  }
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function decodeBase64UrlToUtf8(encoded: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
      return Buffer.from(encoded, "base64url").toString("utf8")
    }
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4))
    const binary = atob(base64 + pad)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 将桌面配对载荷编码为自包含 `pigcode://pair?v=1&d=<base64url>` 口令链接。 */
export function encodeDesktopPairingLink(payload: DesktopPairingPayload): string {
  const checked = desktopPairingPayloadSchema.parse(payload)
  const encoded = encodeUtf8ToBase64Url(JSON.stringify(checked))
  return `${DESKTOP_PAIRING_LINK_PREFIX}?v=1&d=${encoded}`
}

/** 解析粘贴的桌面连接口令（支持 `pigcode://pair?...` 或原始 JSON，明确区分手机端二维码）。 */
export function parseDesktopPairingInput(rawInput: string): ParseDesktopPairingResult {
  const trimmed = rawInput.trim()
  if (!trimmed) return { ok: false, code: "empty" }

  let jsonText = trimmed
  if (trimmed.toLowerCase().startsWith("pigcode://")) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return { ok: false, code: "invalid" }
    }
    if (url.hostname !== "pair" || url.searchParams.get("v") !== "1") {
      return { ok: false, code: "invalid" }
    }
    const encoded = url.searchParams.get("d")?.trim()
    if (!encoded) return { ok: false, code: "invalid" }
    const decoded = decodeBase64UrlToUtf8(encoded)
    if (!decoded) return { ok: false, code: "invalid" }
    jsonText = decoded
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonText)
  } catch {
    return { ok: false, code: "invalid" }
  }

  if (pairingCodeSchema.safeParse(parsedJson).success) {
    return { ok: false, code: "mobile-only" }
  }
  const desktop = desktopPairingPayloadSchema.safeParse(parsedJson)
  if (!desktop.success) {
    return { ok: false, code: "invalid" }
  }
  return { ok: true, payload: desktop.data }
}

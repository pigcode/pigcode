import { z } from "zod"
import { RELAY_PROTOCOL_VERSION } from "./relay"

export const mobileProtocolVersion = 1
export const computerIdSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const devicePlatformSchema = z.enum(["ios", "android"])
export const mobileFeatures = ["connection.status"] as const
export const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const pairingCodeSchema = z.object({
  type: z.literal("pigcode.pair"),
  version: z.literal(1),
  address: z.url({ protocol: /^wss$/ }).max(4096),
  token: z.string().min(1).max(4096),
  computerKey: publicKeySchema,
  computerName: z.string().min(1).max(80),
  secret: publicKeySchema,
  expiresAt: z.number().int(),
})

export const deviceHandshakeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("device.pair"),
    secret: publicKeySchema,
    name: z.string().trim().min(1).max(80),
    platform: devicePlatformSchema,
  }),
  z.object({ type: z.literal("device.connect") }),
])

export const mobileHelloSchema = z.object({
  type: z.literal("mobile.hello"),
  minVersion: z.number().int().positive(),
  maxVersion: z.number().int().positive(),
  features: z.array(z.string().max(80)).max(32),
})

export const pairedDeviceSchema = z.object({
  publicKey: publicKeySchema,
  name: z.string().min(1).max(80),
  platform: devicePlatformSchema,
  lastConnectedAt: z.number().int(),
})

export const mobilePairingParamsSchema = z.object({ id: z.uuid() })
export const mobileConfirmParamsSchema = mobilePairingParamsSchema.extend({
  confirmation: z.uuid(),
})

export const mobilePairingViewSchema = z.object({
  status: z.enum([
    "idle",
    "connecting",
    "waiting",
    "verify",
    "paired",
    "expired",
    "cancelled",
    "relay-unavailable",
    "qr-unavailable",
    "needs-relay",
    "storage-unavailable",
  ]),
  attempt: z
    .object({
      id: z.uuid(),
      expiresAt: z.number().int(),
      qr: z.string().nullable(),
      candidate: z
        .object({ confirmation: z.uuid(), code: z.string(), name: z.string() })
        .nullable(),
    })
    .nullable(),
  devices: z.array(
    pairedDeviceSchema.omit({ publicKey: true }).extend({
      id: computerIdSchema,
      connected: z.boolean(),
    }),
  ),
})

export type PairedDevice = z.infer<typeof pairedDeviceSchema>
export type MobilePairingView = z.infer<typeof mobilePairingViewSchema>

export const relayRegistrationSchema = z.object({
  type: z.enum(["relay.host", "relay.phone"]),
  version: z.literal(RELAY_PROTOCOL_VERSION),
  computerId: computerIdSchema,
  token: z.string().min(1).max(4096),
})

export const relayAdmissionSchema = z.object({
  type: z.literal("relay.result"),
  version: z.literal(RELAY_PROTOCOL_VERSION),
  status: z.enum(["ok", "offline", "busy", "token-rejected", "incompatible"]),
})

export const relaySessionControlSchema = z.object({
  type: z.enum(["relay.open", "relay.close"]),
  session: z.number().int().min(1).max(0xffffffff),
})

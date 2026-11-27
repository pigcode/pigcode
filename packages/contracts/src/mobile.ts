import { z } from "zod"
import { RELAY_PROTOCOL_VERSION } from "./relay"
import {
  apnsEnvironmentSchema,
  invalidApnsRegistrationSchema,
  mobileReminderStatusSchema,
  savedApnsRegistrationSchema,
} from "./mobile-reminders"

export const mobileProtocolVersion = 1
export const desktopProtocolVersion = 1
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const computerIdSchema = fingerprintSchema
export const devicePlatformSchema = z.enum(["ios", "android"])
export const desktopPlatformSchema = z.enum(["macos", "linux", "windows"])
export type DesktopPlatform = z.infer<typeof desktopPlatformSchema>
export const anyDevicePlatformSchema = z.enum(["ios", "android", "macos", "linux", "windows"])
export const clientRoleSchema = z.enum(["mobile", "desktop"])
export type ClientRole = z.infer<typeof clientRoleSchema>
export const mobileFeatures = [
  "connection.status",
  "relay.saveReceipt",
  "sidebar.read",
  "sidebar.write",
  "sidebar.presentation",
  "timeline.read",
  "timeline.resume",
  "run.write",
  "request.write",
  "draft.write",
  "queue.write",
  "changes.read",
  "connection.revocation",
  "reminders.status",
  "reminders.apns",
  "composer.controls",
  "composer.mentions",
  "composer.attachments",
  "workbench.read",
  "workbench.write",
  "preview.tunnel",
  "terminal",
  "projects.manage",
  "agents.manage",
  "schedules.manage",
  "plugins.manage",
  "computer.summary",
] as const
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

const desktopPlatforms = new Set<string>(desktopPlatformSchema.options)

export const deviceHandshakeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("device.pair"),
      role: clientRoleSchema.optional(),
      secret: publicKeySchema,
      name: z.string().trim().min(1).max(80),
      platform: anyDevicePlatformSchema,
    })
    .superRefine((value, ctx) => {
      const role = value.role ?? "mobile"
      const isDesktopPlatform = desktopPlatforms.has(value.platform)
      if (role === "desktop" && !isDesktopPlatform) {
        ctx.addIssue({
          code: "custom",
          path: ["platform"],
          message: "desktop role requires macos, linux, or windows platform",
        })
      } else if (role === "mobile" && isDesktopPlatform) {
        ctx.addIssue({
          code: "custom",
          path: ["platform"],
          message: "mobile role requires ios or android platform",
        })
      }
    }),
  z.object({
    type: z.literal("device.updateRelay"),
    secret: publicKeySchema,
  }),
  z.object({ type: z.literal("device.connect"), revocationNotice: z.boolean().optional() }),
])

export const mobileHelloSchema = z.object({
  type: z.literal("mobile.hello"),
  minVersion: z.number().int().positive(),
  maxVersion: z.number().int().positive(),
  features: z.array(z.string().max(80)).max(32),
})

export const desktopHelloSchema = z.object({
  type: z.literal("desktop.hello"),
  minVersion: z.number().int().positive(),
  maxVersion: z.number().int().positive(),
})

export const pairedDeviceSchema = z.object({
  publicKey: publicKeySchema,
  role: clientRoleSchema.optional(),
  name: z.string().min(1).max(80),
  platform: anyDevicePlatformSchema,
  reminders: mobileReminderStatusSchema.optional(),
  apns: savedApnsRegistrationSchema.optional(),
  invalidApns: invalidApnsRegistrationSchema.optional(),
  lastConnectedAt: z.number().int().nullable(),
  relayRevision: z.uuid().optional(),
  confirmedRelayRevision: z.uuid().optional(),
  authorizationId: z.uuid().optional(),
})

export const mobileRelaySavedSchema = z.object({
  type: z.literal("device.relaySaved"),
  relayRevision: z.uuid(),
})

export const mobileRevokeParamsSchema = z.object({ deviceId: fingerprintSchema })

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
    "update-approved",
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
        .object({
          confirmation: z.uuid(),
          code: z.string(),
          name: z.string(),
          mode: z.enum(["pair", "update"]),
        })
        .nullable(),
    })
    .nullable(),
  devices: z.array(
    pairedDeviceSchema
      .omit({
        role: true,
        publicKey: true,
        relayRevision: true,
        confirmedRelayRevision: true,
        authorizationId: true,
        apns: true,
        invalidApns: true,
      })
      .extend({
        platform: devicePlatformSchema,
        id: fingerprintSchema,
        connected: z.boolean(),
        needsRelayUpdate: z.boolean(),
        pushRegistered: z.boolean().optional(),
      }),
  ),
})

export const mobileRevokeResultSchema = z.object({
  status: z.enum(["revoked", "missing-device", "storage-unavailable"]),
  pairing: mobilePairingViewSchema,
})

export type MobileRevokeResult = z.infer<typeof mobileRevokeResultSchema>
export type PairedDevice = z.infer<typeof pairedDeviceSchema>
export type MobilePairingView = z.infer<typeof mobilePairingViewSchema>

export const relayRegistrationSchema = z.object({
  type: z.enum(["relay.host", "relay.phone"]),
  version: z.literal(RELAY_PROTOCOL_VERSION),
  computerId: computerIdSchema,
  token: z.string().min(1).max(4096),
  statusSupport: z.boolean().optional(),
  apnsSupport: z.boolean().optional(),
})

export const relayWatchSchema = relayRegistrationSchema
  .omit({
    statusSupport: true,
    apnsSupport: true,
  })
  .extend({
    type: z.literal("relay.watch"),
  })

export const relayAdmissionSchema = z.object({
  type: z.literal("relay.result"),
  version: z.literal(RELAY_PROTOCOL_VERSION),
  status: z.enum(["ok", "offline", "busy", "token-rejected", "incompatible"]),
  heartbeatSeconds: z.int().min(1).max(120).optional(),
  apnsChallenge: publicKeySchema.optional(),
  apnsEnvironments: z.array(apnsEnvironmentSchema).max(2).optional(),
})

export const relaySessionControlSchema = z.object({
  type: z.enum(["relay.open", "relay.close"]),
  session: z.number().int().min(1).max(0xffffffff),
})

import { z } from "zod"

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_CONNECT_PATH = "/ws/v1/connect"
export const RELAY_HEARTBEAT_SECONDS = 25

export const relayComputerStateSchema = z.enum(["online", "offline", "sleeping", "exited", "restarting"])
export const relayComputerStatusSchema = z.object({
  type: z.literal("relay.status"),
  state: relayComputerStateSchema,
  lastOnlineAt: z.int().nonnegative().nullable(),
})
export type RelayComputerStatus = z.infer<typeof relayComputerStatusSchema>
export type RelayHostLifecycle = "sleeping" | "exited" | "restarting"

const relayProbeStatusSchema = z.enum(["ok", "token-rejected", "incompatible"])
export type RelayProbeStatus = z.infer<typeof relayProbeStatusSchema>

export const relayProbeResultSchema = z.object({
  type: z.literal("relay.probe.result"),
  version: z.literal(RELAY_PROTOCOL_VERSION),
  status: relayProbeStatusSchema,
})

export const relaySettingsSchema = z.object({
  address: z.string().nullable(),
  tokenConfigured: z.boolean(),
})

export const relayTestAndSaveParamsSchema = z.object({
  address: z.string().max(4096),
  token: z.string().max(4096).optional(),
})

export const relayTestResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), settings: relaySettingsSchema }),
  z.object({
    status: z.enum([
      "invalid-address",
      "token-required",
      ...relayProbeStatusSchema.exclude(["ok"]).options,
      "unreachable",
      "storage-unavailable",
      "busy",
    ]),
  }),
])

export type RelaySettingsView = z.infer<typeof relaySettingsSchema>
export type RelayTestAndSaveParams = z.infer<typeof relayTestAndSaveParamsSchema>
export type RelayTestResult = z.infer<typeof relayTestResultSchema>

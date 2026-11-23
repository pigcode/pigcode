import { z } from "zod"

export const reminderKind = z.enum(["approval", "question", "completed", "failed"])
export const hostReminderSchema = z.strictObject({
  version: z.int().min(1).max(1),
  eventId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(128),
  kind: reminderKind,
})
export const mobileReminderSchema = hostReminderSchema.extend({
  computerId: z.string().regex(/^[0-9a-f]{64}$/),
})

export const mobileReminderPermission = z.enum(["granted", "denied", "undetermined"])
export const apnsEnvironmentSchema = z.enum(["sandbox", "production"])
const apnsTokenSchema = z.string().regex(/^(?:[0-9a-f]{2}){1,128}$/)
export const mobileApnsRegistrationSchema = z.strictObject({
  token: apnsTokenSchema,
  environment: apnsEnvironmentSchema,
  observationId: z.uuid(),
})
export const mobileReminderSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  permission: mobileReminderPermission,
  apns: mobileApnsRegistrationSchema.optional(),
})
export const mobileReminderStatusSchema = mobileReminderSettingsSchema.omit({ apns: true }).extend({
  syncedAt: z.number().int().nonnegative(),
})
export const mobileReminderMethods = {
  report: "mobile.reminder-settings",
  configure: "mobile.reminders.configure",
} as const
export const mobileReminderReportSchema = mobileReminderSettingsSchema.omit({ apns: true }).extend({
  type: z.literal(mobileReminderMethods.report),
})

export type HostReminder = z.infer<typeof hostReminderSchema>
export type MobileReminderSettings = z.infer<typeof mobileReminderSettingsSchema>
export type MobileApnsRegistration = z.infer<typeof mobileApnsRegistrationSchema>
export type ApnsEnvironment = z.infer<typeof apnsEnvironmentSchema>

export const savedApnsRegistrationSchema = z.object({
  registrationId: z.uuid(),
  environment: apnsEnvironmentSchema,
  sealedToken: z.string().min(1).max(16384),
  fingerprint: mobileReminderSchema.shape.computerId,
  observationId: z.uuid(),
})

export const invalidApnsRegistrationSchema = savedApnsRegistrationSchema.pick({
  fingerprint: true,
  observationId: true,
})

export const relayPushInvalidSchema = z.strictObject({
  type: z.literal("relay.push.invalid"),
  deviceId: mobileReminderSchema.shape.computerId,
  registrationId: z.uuid(),
})

export function mobileReminderJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  registry.add(reminderKind, { id: "ReminderKind" })
  registry.add(mobileReminderSchema, { id: "MobileReminder" })
  registry.add(mobileReminderPermission, { id: "MobileReminderPermission" })
  registry.add(apnsEnvironmentSchema, { id: "ApnsEnvironment" })
  registry.add(mobileApnsRegistrationSchema, { id: "MobileApnsRegistration" })
  registry.add(mobileReminderSettingsSchema, { id: "MobileReminderSettings" })
  return z.toJSONSchema(registry).schemas
}

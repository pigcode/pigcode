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
export const mobileReminderSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  permission: mobileReminderPermission,
})
export const mobileReminderStatusSchema = mobileReminderSettingsSchema.extend({
  syncedAt: z.number().int().nonnegative(),
})
export const mobileReminderMethods = { report: "mobile.reminder-settings" } as const
export const mobileReminderReportSchema = mobileReminderSettingsSchema.extend({
  type: z.literal(mobileReminderMethods.report),
})

export type HostReminder = z.infer<typeof hostReminderSchema>
export type MobileReminderSettings = z.infer<typeof mobileReminderSettingsSchema>

export function mobileReminderJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  registry.add(reminderKind, { id: "ReminderKind" })
  registry.add(mobileReminderSchema, { id: "MobileReminder" })
  registry.add(mobileReminderPermission, { id: "MobileReminderPermission" })
  registry.add(mobileReminderSettingsSchema, { id: "MobileReminderSettings" })
  return z.toJSONSchema(registry).schemas
}

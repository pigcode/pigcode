/** 桌面端多主机管理与远程文件目录浏览契约。 */
import { z } from "zod"
import { hostRuntimeKindSchema } from "./host-admin"
import { publicKeySchema } from "./mobile"

export const HOST_LOCAL_ID = "local"

export const hostKindSchema = z.enum(["local", "desktop", "headless"])
export type HostKind = z.infer<typeof hostKindSchema>

export const hostBadgeColorSchema = z.enum(["blue", "green", "amber", "violet", "rose", "slate"])
export type HostBadgeColor = z.infer<typeof hostBadgeColorSchema>

export const hostChannelSchema = z.enum(["local", "lan", "relay"])
export type HostChannel = z.infer<typeof hostChannelSchema>

export const hostConnectionStatusSchema = z.enum([
  "connected",
  "connecting",
  "offline",
  "auth-failed",
  "revoked",
  "incompatible",
])
export type HostConnectionStatus = z.infer<typeof hostConnectionStatusSchema>

export const hostSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  hostKey: publicKeySchema.nullable(),
  kind: hostKindSchema,
  badgeColor: hostBadgeColorSchema,
  status: hostConnectionStatusSchema,
  channel: hostChannelSchema,
  latencyMs: z.number().int().nonnegative().nullable(),
  lanAddresses: z.array(z.string()),
  relayAddress: z.string().nullable(),
  lastConnectedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
})

export type HostSummary = z.infer<typeof hostSummarySchema>

export const hostIdentitySchema = z.object({
  hostKey: publicKeySchema,
  hostName: z.string().min(1).max(80),
  runtime: hostRuntimeKindSchema,
})

export type HostIdentity = z.infer<typeof hostIdentitySchema>

export const hostBrowseDirEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  isGitRepo: z.boolean(),
  hasChildren: z.boolean(),
})

export type HostBrowseDirEntry = z.infer<typeof hostBrowseDirEntrySchema>

export const hostBrowseDirsResultSchema = z.object({
  path: z.string().min(1),
  parentPath: z.string().nullable(),
  homePath: z.string().min(1),
  entries: z.array(hostBrowseDirEntrySchema),
})

export type HostBrowseDirsResult = z.infer<typeof hostBrowseDirsResultSchema>

export const hostOutboundPairingStatusSchema = z.object({
  state: z.enum(["idle", "connecting", "verify", "paired", "failed"]),
  hostName: z.string().nullable(),
  hostKey: publicKeySchema.nullable(),
  verificationCode: z.string().nullable(),
  hostId: z.string().nullable(),
  errorCode: z.string().nullable(),
})

export type HostOutboundPairingStatus = z.infer<typeof hostOutboundPairingStatusSchema>

export const hostDefaultsSchema = z.object({
  defaultTargetHostId: z.string().min(1),
})

export type HostDefaults = z.infer<typeof hostDefaultsSchema>

export const desktopWelcomeSchema = z.object({
  type: z.literal("desktop.welcome"),
  version: z.number().int().positive(),
  hostKey: z.string().min(1),
  hostName: z.string().min(1),
  runtime: hostRuntimeKindSchema.optional(),
  lanAddresses: z.array(z.string()).optional(),
})

export type DesktopWelcome = z.infer<typeof desktopWelcomeSchema>

export const storedRemoteHostSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  hostKey: publicKeySchema,
  kind: hostRuntimeKindSchema.default("desktop"),
  badgeColor: hostBadgeColorSchema.default("green"),
  relayAddress: z.string().min(1).nullable().default(null),
  relayTokenSealed: z.string().min(1).nullable().default(null),
  lanAddresses: z.array(z.string().min(1)).default([]),
  lastConnectedAt: z.number().int().nullable().default(null),
})

export type StoredRemoteHost = z.infer<typeof storedRemoteHostSchema>

export const remoteHostsFileSchema = z.object({
  version: z.literal(1).default(1),
  clientKeySealed: z.string().min(1).optional(),
  defaultTargetHostId: z.string().min(1).default(HOST_LOCAL_ID),
  hosts: z.array(storedRemoteHostSchema).default([]),
})

export type RemoteHostsFile = z.infer<typeof remoteHostsFileSchema>

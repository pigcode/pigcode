/** Host 单实例锁与本机控制通道（host.sock）的共享契约、参数校验与响应协议。 */
import { z } from "zod"
import {
  desktopAuthorizedClientSchema,
  desktopPairingViewSchema,
  desktopRevokeResultSchema,
} from "./desktop-pairing"
import {
  mobileConfirmParamsSchema,
  mobilePairingParamsSchema,
  mobilePairingViewSchema,
  mobileRevokeParamsSchema,
  mobileRevokeResultSchema,
  publicKeySchema,
} from "./mobile"
import { relaySettingsSchema, relayTestAndSaveParamsSchema, relayTestResultSchema } from "./relay"

/** profile 目录下的跨运行时单实例锁文件名。 */
export const HOST_LOCK_FILE = "host.lock"
/** profile 目录下的本机控制通道文件名（POSIX）。 */
export const HOST_SOCKET_FILE = "host.sock"

/** Host 运行时形态：桌面主应用托管或无窗口常驻进程。 */
export const hostRuntimeKindSchema = z.enum(["desktop", "headless"])
export type HostRuntimeKind = z.infer<typeof hostRuntimeKindSchema>

/** `host.lock` 持久化元数据。 */
export const hostLockMetadataSchema = z.strictObject({
  pid: z.number().int().positive(),
  instanceId: z.uuid(),
  runtime: hostRuntimeKindSchema,
  socketPath: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  version: z.string().min(1),
})
export type HostLockMetadata = z.infer<typeof hostLockMetadataSchema>

/** `host.status` 返回的运行状态摘要。 */
export const hostStatusViewSchema = z.strictObject({
  pid: z.number().int().positive(),
  runtime: hostRuntimeKindSchema,
  version: z.string().min(1),
  profileDir: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  relay: relaySettingsSchema,
  lanAddresses: z.array(z.string()),
  activeRuns: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  pairedDevices: z.number().int().nonnegative(),
  hostName: z.string().min(1).max(80).optional(),
  hostKey: publicKeySchema.optional(),
  pairedDesktops: z.number().int().nonnegative().optional(),
})
export type HostStatusView = z.infer<typeof hostStatusViewSchema>

const emptyStrictParamsSchema = z.strictObject({})
const hostStopResultSchema = z.strictObject({ stopping: z.literal(true) })
const hostSetNameParamsSchema = z.strictObject({ name: z.string().trim().min(1).max(80) })
const hostSetNameResultSchema = z.strictObject({ hostName: z.string().min(1).max(80) })

/** 本机控制通道支持的方法名与参数 schema 映射。 */
export const hostAdminMethodParamsSchemas = {
  "host.status": emptyStrictParamsSchema,
  "host.setName": hostSetNameParamsSchema,
  "host.stop": z.strictObject({ reason: z.enum(["exited", "restarting"]).optional() }),
  "relay.view": emptyStrictParamsSchema,
  "relay.testAndSave": relayTestAndSaveParamsSchema,
  "relay.clear": emptyStrictParamsSchema,
  "mobile.pairing.view": emptyStrictParamsSchema,
  "mobile.pairing.start": emptyStrictParamsSchema,
  "mobile.pairing.cancel": mobilePairingParamsSchema,
  "mobile.pairing.confirm": mobileConfirmParamsSchema,
  "mobile.devices.list": emptyStrictParamsSchema,
  "mobile.devices.revoke": mobileRevokeParamsSchema,
  "desktop.pairing.view": emptyStrictParamsSchema,
  "desktop.pairing.start": emptyStrictParamsSchema,
  "desktop.pairing.cancel": mobilePairingParamsSchema,
  "desktop.pairing.confirm": mobileConfirmParamsSchema,
  "desktop.devices.list": emptyStrictParamsSchema,
  "desktop.devices.revoke": mobileRevokeParamsSchema,
} as const

/** 本机控制通道各方法的返回值 schema 映射。 */
export const hostAdminMethodResultSchemas = {
  "host.status": hostStatusViewSchema,
  "host.setName": hostSetNameResultSchema,
  "host.stop": hostStopResultSchema,
  "relay.view": relaySettingsSchema,
  "relay.testAndSave": relayTestResultSchema,
  "relay.clear": relaySettingsSchema,
  "mobile.pairing.view": mobilePairingViewSchema,
  "mobile.pairing.start": mobilePairingViewSchema,
  "mobile.pairing.cancel": mobilePairingViewSchema,
  "mobile.pairing.confirm": mobilePairingViewSchema,
  "mobile.devices.list": mobilePairingViewSchema.shape.devices,
  "mobile.devices.revoke": mobileRevokeResultSchema,
  "desktop.pairing.view": desktopPairingViewSchema,
  "desktop.pairing.start": desktopPairingViewSchema,
  "desktop.pairing.cancel": desktopPairingViewSchema,
  "desktop.pairing.confirm": desktopPairingViewSchema,
  "desktop.devices.list": z.array(desktopAuthorizedClientSchema),
  "desktop.devices.revoke": desktopRevokeResultSchema,
} as const

export type HostAdminMethod = keyof typeof hostAdminMethodParamsSchemas
export type HostAdminParams<M extends HostAdminMethod = HostAdminMethod> = z.infer<
  (typeof hostAdminMethodParamsSchemas)[M]
>

/** 各控制方法的返回类型映射。 */
export type HostAdminResultMap = {
  [M in HostAdminMethod]: z.infer<(typeof hostAdminMethodResultSchemas)[M]>
}

/** 本机控制通道 NDJSON 请求信封。 */
export const hostAdminRequestSchema = z.strictObject({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
})
export type HostAdminRequest = z.infer<typeof hostAdminRequestSchema>

/** 本机控制通道 NDJSON 响应信封。 */
export const hostAdminResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.string().min(1),
    code: z.string().min(1).optional(),
  }),
])
export type HostAdminResponse = z.infer<typeof hostAdminResponseSchema>

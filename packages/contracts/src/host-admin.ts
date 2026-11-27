/** Host 单实例锁与本机控制通道（host.sock）的共享契约、参数校验与响应协议。 */
import { z } from "zod"
import {
  mobileConfirmParamsSchema,
  mobilePairingParamsSchema,
  mobileRevokeParamsSchema,
  type MobilePairingView,
  type MobileRevokeResult,
} from "./mobile"
import {
  relaySettingsSchema,
  relayTestAndSaveParamsSchema,
  type RelaySettingsView,
  type RelayTestResult,
} from "./relay"

/** profile 目录下的跨运行时单实例锁文件名。 */
export const HOST_LOCK_FILE = "host.lock"
/** profile 目录下的本机控制通道文件名（POSIX）。 */
export const HOST_SOCKET_FILE = "host.sock"

/** Host 运行时形态：桌面主应用托管或无窗口常驻进程。 */
export const hostRuntimeKindSchema = z.enum(["desktop", "headless"])
export type HostRuntimeKind = z.infer<typeof hostRuntimeKindSchema>

/** `host.lock` 持久化元数据。 */
export const hostLockMetadataSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.uuid(),
  runtime: hostRuntimeKindSchema,
  socketPath: z.string(),
  startedAt: z.number().int().nonnegative(),
  version: z.string(),
})
export type HostLockMetadata = z.infer<typeof hostLockMetadataSchema>

/** `host.status` 返回的运行状态摘要。 */
export const hostStatusViewSchema = z.object({
  pid: z.number().int().positive(),
  runtime: hostRuntimeKindSchema,
  version: z.string(),
  profileDir: z.string(),
  startedAt: z.number().int().nonnegative(),
  relay: relaySettingsSchema,
  lanAddresses: z.array(z.string()),
  activeRuns: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  pairedDevices: z.number().int().nonnegative(),
})
export type HostStatusView = z.infer<typeof hostStatusViewSchema>

/** 本机控制通道支持的方法名与参数 schema 映射。 */
export const hostAdminMethodParamsSchemas = {
  "host.status": z.object({}),
  "host.stop": z.object({ reason: z.enum(["exited", "restarting"]).optional() }),
  "relay.view": z.object({}),
  "relay.testAndSave": relayTestAndSaveParamsSchema,
  "relay.clear": z.object({}),
  "mobile.pairing.view": z.object({}),
  "mobile.pairing.start": z.object({}),
  "mobile.pairing.cancel": mobilePairingParamsSchema,
  "mobile.pairing.confirm": mobileConfirmParamsSchema,
  "mobile.devices.list": z.object({}),
  "mobile.devices.revoke": mobileRevokeParamsSchema,
} as const

export type HostAdminMethod = keyof typeof hostAdminMethodParamsSchemas
export type HostAdminParams<M extends HostAdminMethod = HostAdminMethod> = z.infer<
  (typeof hostAdminMethodParamsSchemas)[M]
>

/** 各控制方法的返回类型映射。 */
export interface HostAdminResultMap {
  "host.status": HostStatusView
  "host.stop": { stopping: true }
  "relay.view": RelaySettingsView
  "relay.testAndSave": RelayTestResult
  "relay.clear": RelaySettingsView
  "mobile.pairing.view": MobilePairingView
  "mobile.pairing.start": MobilePairingView
  "mobile.pairing.cancel": MobilePairingView
  "mobile.pairing.confirm": MobilePairingView
  "mobile.devices.list": MobilePairingView["devices"]
  "mobile.devices.revoke": MobileRevokeResult
}

/** 本机控制通道 NDJSON 请求信封。 */
export const hostAdminRequestSchema = z.object({
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

/** 手机端本机预览隧道的在途请求与流式响应注册表，负责配额校验、空闲过期及设备撤销清理。 */
import type { Context } from "cordis"
import { MobileRequestError } from "./request-error"

export interface PreviewOwner {
  forgetInFlight(entry: ActiveFetchEntry): void
  forgetStream(streamId: string): void
}

export interface ActiveFetchEntry {
  ownerDeviceKey: string
  owner: PreviewOwner
  controller: AbortController
  abortedByLifecycle: boolean
}

export interface PreviewStreamEntry {
  streamId: string
  ownerDeviceKey: string
  owner: PreviewOwner
  buffer: Buffer
  totalBytes: number
  timer: ReturnType<typeof setTimeout>
}

export interface PreviewRegistry {
  inFlight: Set<ActiveFetchEntry>
  streams: Map<string, PreviewStreamEntry>
}

const registryByContext = new WeakMap<Context, PreviewRegistry>()

export function getPreviewRegistry(ctx: Context): PreviewRegistry | undefined {
  return registryByContext.get(ctx)
}

export function previewRegistry(ctx: Context): PreviewRegistry {
  let registry = registryByContext.get(ctx)
  if (!registry) {
    registry = {
      inFlight: new Set(),
      streams: new Map(),
    }
    registryByContext.set(ctx, registry)
  }
  return registry
}

export function disposeStreamEntry(registry: PreviewRegistry, entry: PreviewStreamEntry): void {
  clearTimeout(entry.timer)
  registry.streams.delete(entry.streamId)
  entry.owner.forgetStream(entry.streamId)
}

export function armPreviewStreamTimer(
  ctx: Context,
  streamId: string,
  idleTtlMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const registry = registryByContext.get(ctx)
    const entry = registry?.streams.get(streamId)
    if (registry && entry) disposeStreamEntry(registry, entry)
  }, idleTtlMs)
  timer.unref?.()
  return timer
}

export function countDeviceInFlightFetches(registry: PreviewRegistry, deviceKey: string): number {
  let activeForDevice = 0
  for (const active of registry.inFlight) {
    if (active.ownerDeviceKey === deviceKey) activeForDevice += 1
  }
  return activeForDevice
}

export function assertDeviceStreamQuota(
  registry: PreviewRegistry,
  deviceKey: string,
  nextBytes: number,
  maxStreams: number,
  maxBytes: number,
): void {
  let deviceStreamCount = 0
  let deviceStreamBytes = 0
  for (const existing of registry.streams.values()) {
    if (existing.ownerDeviceKey !== deviceKey) continue
    deviceStreamCount += 1
    deviceStreamBytes += existing.totalBytes
  }
  if (deviceStreamCount >= maxStreams || deviceStreamBytes + nextBytes > maxBytes) {
    throw new MobileRequestError("PREVIEW_TOO_LARGE")
  }
}

/** 撤销设备配对时，立即中止该设备所有在途预览请求并清空该设备全部预览响应流。 */
export function cleanupDeviceMobilePreviews(ctx: Context, deviceKey: string): void {
  const registry = registryByContext.get(ctx)
  if (!registry) return

  for (const active of [...registry.inFlight]) {
    if (active.ownerDeviceKey !== deviceKey) continue
    active.abortedByLifecycle = true
    registry.inFlight.delete(active)
    active.owner.forgetInFlight(active)
    active.controller.abort()
  }

  for (const entry of [...registry.streams.values()]) {
    if (entry.ownerDeviceKey !== deviceKey) continue
    disposeStreamEntry(registry, entry)
  }
}

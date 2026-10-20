/** 注册 provider driver，并把一次 run 的规范化事件映射为线程事件。 */
import type { Context } from "cordis"
import type { ProviderCapabilities, ProviderEvent } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type { ProviderDriver } from "./driver"
import { FakeProviderDriver } from "./fake"

/** provider 注册表与启动运行的入口。 */
export interface ProvidersService {
  register(driver: ProviderDriver): void
  list(): Array<{ id: string; displayName: string; capabilities: ProviderCapabilities }>
  startRun(
    threadId: string,
    text: string,
    emitLive: (event: ProviderEvent) => void,
  ): Promise<{ runId: string }>
}

declare module "cordis" {
  interface Context {
    providers: ProvidersService
  }
}

/** providers 插件依赖的线程与事件服务。 */
export const inject = ["threads", "sessions"]

/** providers 插件函数，注册 fake provider 并提供 startRun。 */
export function apply(ctx: Context): void {
  const drivers = new Map<string, ProviderDriver>()
  const fake = new FakeProviderDriver()
  drivers.set(fake.id, fake)

  const service: ProvidersService = {
    register(driver) {
      drivers.set(driver.id, driver)
    },
    list() {
      return [...drivers.values()].map((driver) => ({
        id: driver.id,
        displayName: driver.displayName,
        capabilities: driver.capabilities,
      }))
    },
    async startRun(threadId, text, emitLive) {
      const thread = ctx.threads.get(threadId)
      if (!thread) throw new Error(`thread not found: ${threadId}`)
      const driver = drivers.get(thread.defaultProviderId)
      if (!driver) throw new Error(`provider not found: ${thread.defaultProviderId}`)

      const session = await driver.createSession({ threadId, cwd: process.cwd() })
      const runId = `run_${randomUUID()}`
      const createdAt = new Date().toISOString()

      ctx.sessions.append({
        threadId,
        runId,
        type: "run.started",
        payload: { providerId: driver.id, providerSessionId: session.id },
        schemaVersion: 1,
        createdAt,
      })

      await driver.send(session, { text }, (event) => {
        if (event.type === "message.delta") {
          emitLive(event)
          return
        }
        if (event.type === "run.started") return
        if (event.type === "message.completed") {
          ctx.sessions.append({
            threadId,
            runId,
            type: "message.completed",
            payload: { text: event.text },
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          })
          return
        }
        if (event.type === "run.completed") {
          ctx.sessions.append({
            threadId,
            runId,
            type: "run.completed",
            payload: {},
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          })
          return
        }
        ctx.sessions.append({
          threadId,
          runId,
          type: "run.failed",
          payload: { message: event.message },
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        })
      })

      return { runId }
    },
  }

  ctx.provide("providers", service)
}

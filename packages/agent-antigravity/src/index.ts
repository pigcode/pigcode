import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { AntigravityDriver } from "./driver"

export const name = "agent-antigravity"
export const inject = ["agents"]

export function apply(ctx: PluginHostContext): void {
  const driver = new AntigravityDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}

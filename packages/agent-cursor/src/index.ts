import "./worker"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { CursorDriver } from "./driver"

export const name = "agent-cursor"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  const driver = new CursorDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}

import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { MuseDriver } from "./driver"

export const name = "agent-muse"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  const driver = new MuseDriver()
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}

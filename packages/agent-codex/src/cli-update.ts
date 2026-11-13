/** Codex 插件定义自己的更新目标，更新后刷新后续 run 的 app-server。 */
import type { AgentSettingsValues } from "@pigcode/plugin-sdk"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"
import { codexLaunch } from "./launch"

export async function prepareCodexCliUpdate(settings: AgentSettingsValues, onUpdated: () => void) {
  const launch = codexLaunch(settings)
  const plan = await preparePackageCliUpdate({
    executable: launch.command,
    env: launch.env,
    packageName: "@openai/codex",
    brewFormula: "codex",
  })
  const update = plan.run
  if (!update) return plan
  return {
    ...plan,
    run: async (runtime: Parameters<typeof update>[0]) => {
      try {
        await update(runtime)
      } finally {
        onUpdated()
      }
    },
  }
}

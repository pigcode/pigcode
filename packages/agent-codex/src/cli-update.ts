/** Codex 插件定义自己的更新目标，更新后刷新后续 run 的 app-server。 */
import type {
  AgentSettingsValues,
  AgentInstanceContext,
  AgentCliUpdatePlan,
} from "@pigcode/plugin-sdk"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"
import { ManagedCodexRuntime, managedCodexVersion } from "./managed-runtime"
import { codexLaunch } from "./launch"

export async function prepareCodexCliUpdate(
  settings: AgentSettingsValues,
  onUpdated: () => void,
  managed: ManagedCodexRuntime,
  scope?: AgentInstanceContext,
): Promise<AgentCliUpdatePlan> {
  if (settings.setupMode === "managed" && scope && !(await managed.local(settings))) {
    const command = await managed.resolve(settings, scope)
    const version = command ? managedCodexVersion : null
    return {
      target: command ?? scope.sharedDir,
      currentVersion: version,
      latestVersion: managedCodexVersion,
      available: false,
      command: null,
      reason: command ? null : "not-installed",
      verify: async () => version,
    }
  }
  // 包管理器只操作 CLI 安装，账号隔离目录与更新目标无关。
  const launch = codexLaunch({ ...settings, setupMode: "existing", shadowHomePath: "" })
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

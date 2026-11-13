/** Claude 插件定义包名、Homebrew 名称和原生更新通道。 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentSettingsValues } from "@pigcode/plugin-sdk"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"
import { claudeLaunch } from "./launch"

export async function prepareClaudeCliUpdate(
  settings: AgentSettingsValues,
  fixedExecutable?: string,
) {
  const launch = claudeLaunch(settings, fixedExecutable)
  const configDir =
    launch.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  let channel = "latest"
  try {
    const config = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as {
      autoUpdatesChannel?: string
    }
    if (config.autoUpdatesChannel === "stable") channel = "stable"
  } catch {
    // CLI 缺省使用 latest。
  }
  return preparePackageCliUpdate({
    executable: launch.executable ?? "claude",
    env: launch.env,
    packageName: "@anthropic-ai/claude-code",
    brewFormula: "claude-code",
    native: {
      matches: (path) =>
        /\/\.local\/(?:share\/claude\/versions\/|bin\/claude\.exe$)/i.test(
          path.replaceAll("\\", "/"),
        ),
      args: ["update"],
      versionUrl: `https://downloads.claude.ai/claude-code-releases/${channel}`,
    },
  })
}

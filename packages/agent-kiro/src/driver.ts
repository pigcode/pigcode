import {
  jsonRecord,
  parseCliObject,
  type CliProbe,
  type NativeAcpDefinition,
} from "@pigcode/acp-runtime"
import { settingString } from "@pigcode/plugin-sdk"

async function account(run: CliProbe, env: NodeJS.ProcessEnv) {
  const result = await run(["whoami", "--format", "json"])
  const who = parseCliObject(result.text.split("\n", 1)[0] ?? "")
  if (!result.ok) return { authenticated: who.account === null ? false : null }
  return {
    authenticated: true,
    account: env.KIRO_API_KEY || who.accountType === "ApiKey" ? "Kiro API key" : "Kiro",
    ...(typeof who.email === "string" ? { email: who.email } : {}),
  }
}

// --list-models 只给模型名。推理档位取自 T3 所核对的 Kiro V3 目录，写入时再以当前会话的公告为准。
const levels = ["low", "medium", "high", "xhigh", "max"]
function reasoning(model: string, isDefault: boolean) {
  if (isDefault) return {}
  if (/^claude-(?:fable-5\.1|opus-(?:5(?:\.5)?|4\.[78])|sonnet-5(?:\.5)?)$/.test(model))
    return {
      efforts: levels,
      defaultEffort:
        model === "claude-opus-4.7" ? "xhigh" : model === "claude-opus-5.5" ? "medium" : "high",
    }
  if (/^claude-(?:opus|sonnet)-4\.6$/.test(model))
    return { efforts: ["low", "medium", "high", "max"], defaultEffort: "high" }
  if (/^gpt-5\.6-(?:sol|terra|luna)$/.test(model))
    return { efforts: ["none", ...levels], defaultEffort: "high" }
  if (model === "kimi-k3") return { efforts: ["low", "high", "max"], defaultEffort: "max" }
  return {}
}

export const kiro: NativeAcpDefinition = {
  id: "kiro",
  name: "Kiro",
  command: "kiro-cli",
  args: () => ["acp", "--agent-engine=v3", "--auth-method=cli"],
  environment(settings) {
    const key = settingString(settings, "apiKey")
    return key ? { KIRO_API_KEY: key } : {}
  },
  account,
  async models(run, env) {
    if ((await account(run, env)).authenticated !== true) return []
    const listing = parseCliObject((await run(["chat", "--list-models", "--format", "json"])).text)
    if (!Array.isArray(listing.models)) return []
    return listing.models.flatMap((raw) => {
      const model = jsonRecord(raw)
      if (typeof model.model_id !== "string") return []
      const isDefault = model.model_id === listing.default_model
      return [
        {
          id: model.model_id,
          displayName: typeof model.model_name === "string" ? model.model_name : model.model_id,
          isDefault,
          ...reasoning(model.model_id, isDefault),
        },
      ]
    })
  },
  protocol: {
    effortId: "effortLevel",
    deferredEffort: true,
    approvalMode: (mode) => (mode === "full-access" ? mode : "approval-required"),
    sessionPolicy: (_setup, mode) => ({
      id: "autopilot",
      value: mode === "full-access" ? "on" : "off",
    }),
  },
}

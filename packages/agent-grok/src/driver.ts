import { asReasoningEffort, type AgentModelInfo } from "@pigcode/plugin-sdk"
import { jsonRecord, type NativeAcpDefinition } from "@pigcode/acp-runtime"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"

function sessionEnd(method: string, params: unknown, sessionId: string, promptId: string) {
  const note = jsonRecord(params)
  if (note.sessionId !== sessionId) return undefined
  let source = note
  if (
    ["x.ai/session_notification", "_x.ai/session_notification", "_x.ai/session/update"].includes(
      method,
    )
  ) {
    source = jsonRecord(note.update)
    if (source.sessionUpdate !== "turn_completed") return undefined
  } else if (
    method !== "x.ai/session/prompt_complete" &&
    method !== "_x.ai/session/prompt_complete"
  )
    return undefined
  if ((source.promptId ?? source.prompt_id) !== promptId) return undefined
  const reason = source.stopReason ?? source.stop_reason
  const known = [
    "end_turn",
    "cancelled",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "error",
    "rate_limit",
  ]
  return typeof reason === "string" && known.includes(reason) ? reason : "end_turn"
}

export const grok: NativeAcpDefinition = {
  id: "grok",
  name: "Grok",
  command: "grok",
  prepareUpdate(executable, env) {
    return preparePackageCliUpdate({
      executable,
      env,
      packageName: "@xai-official/grok",
      brewFormula: "grok",
      native: {
        matches: (path) =>
          !/(?:\/nix\/store\/|\/mise\/|\/Cellar\/|\/Caskroom\/|\/node_modules\/)/i.test(path) &&
          /\/grok(?:\.exe)?$/i.test(path),
        args: ["update"],
        env: { npm_config_allow_scripts: "@xai-official/grok" },
        versionUrl: "https://registry.npmjs.org/@xai-official%2Fgrok/latest",
        versionFormat: "npm",
      },
    })
  },
  args(mode) {
    if (mode === "full-access") return ["agent", "--always-approve", "stdio"]
    if (mode) return ["--permission-mode", mode === "auto" ? "auto" : "default", "agent", "stdio"]
    return ["agent", "stdio"]
  },
  async account(run, env) {
    if (env.XAI_API_KEY?.trim()) return { authenticated: true, account: "xAI API key" }
    let result = await run(["models"])
    // Grok 可能显示过期状态，再在退出前刷新 token。
    if (result.ok && /not authenticated|not logged in/i.test(result.text)) {
      const recheck = await run(["models"])
      if (recheck.ok) result = recheck
    }
    if (!result.ok) return { authenticated: null }
    if (/you are logged in/i.test(result.text)) return { authenticated: true, account: "Grok" }
    return { authenticated: /not authenticated|not logged in/i.test(result.text) ? false : null }
  },
  async models(run) {
    const { text, ok } = await run(["models"])
    if (!ok) return []
    const ids = new Map<string, boolean>()
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*[*-]\s+(\S+)(.*)$/.exec(line)
      if (match?.[1]) ids.set(match[1], /\(default\)/i.test(match[2] ?? ""))
    }
    return [...ids].map(([id, isDefault]) => ({ id, displayName: id, isDefault }))
  },
  metadata(info) {
    const state = jsonRecord(info._meta?.modelState)
    const models = Array.isArray(state.availableModels)
      ? state.availableModels.flatMap((item): AgentModelInfo[] => {
          const { modelId, name, description, _meta } = jsonRecord(item)
          if (typeof modelId !== "string" || !modelId) return []
          const meta = jsonRecord(_meta)
          const choices =
            meta.supportsReasoningEffort === false || !Array.isArray(meta.reasoningEfforts)
              ? []
              : meta.reasoningEfforts.map(jsonRecord)
          const efforts = [
            ...new Set(
              choices.flatMap((option) => asReasoningEffort(option.value ?? option.id) ?? []),
            ),
          ]
          const suggested = choices.find(
            (option) => option.default === true || option.isDefault === true,
          )
          const selected =
            asReasoningEffort(meta.reasoningEffort) ??
            asReasoningEffort(suggested?.value ?? suggested?.id)
          return [
            {
              id: modelId,
              displayName: typeof name === "string" ? name : modelId,
              ...(typeof description === "string" ? { description } : {}),
              isDefault: modelId === state.currentModelId,
              efforts,
              defaultEffort: selected && efforts.includes(selected) ? selected : null,
            },
          ]
        })
      : []
    const rawCommands = info._meta?.availableCommands
    const commands = Array.isArray(rawCommands)
      ? rawCommands.flatMap((item) => {
          const { name, description, input } = jsonRecord(item)
          if (
            typeof name !== "string" ||
            !name ||
            /\s/.test(name) ||
            ["always-approve", "context", "logout"].includes(name.toLowerCase())
          )
            return []
          const hint = jsonRecord(input).hint
          return [
            {
              name,
              text: "/" + name,
              kind: "builtin" as const,
              ...(typeof description === "string" ? { description } : {}),
              ...(typeof hint === "string" ? { argumentHint: hint } : {}),
            },
          ]
        })
      : []
    return { models, commands }
  },
  protocol: {
    initializeMeta: { clientType: "extension" },
    cancelMeta: { cancelTrigger: "ctrl_c" },
    authMethod: (launch) => (launch.env?.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token"),
    approvalMode: (mode) => (mode === "full-access" ? "full-access" : "approval-required"),
    legacyModelEffort: true,
    promptCompletion: sessionEnd,
  },
}

import type {
  AvailableCommand,
  NewSessionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk"
import {
  asReasoningEffort,
  type AgentCommandInfo,
  type AgentModelInfo,
  type AgentSessionHandle,
  type UserInput,
} from "@pigcode/plugin-sdk"
import { isAuthRequired, requestOptions, type AcpProcess } from "./connection"

export type SessionSetup = (NewSessionResponse | ResumeSessionResponse) & {
  models?: {
    currentModelId?: string
    availableModels?: Array<{ modelId: string; name: string; description?: string }>
  }
}

export function selectConfig(config: readonly SessionConfigOption[], category: string) {
  return config.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && (option.category === category || option.id === category),
  )
}

export function configChoices(
  config: SessionConfigSelect | undefined,
): SessionConfigSelectOption[] {
  return config?.options.flatMap((value) => ("value" in value ? [value] : value.options)) ?? []
}

export function nativeModels(setup: SessionSetup): AgentModelInfo[] {
  const config = selectConfig(setup.configOptions ?? [], "model")
  if (config) {
    return configChoices(config).map(({ value, name, description }) => ({
      id: value,
      displayName: name,
      ...(description ? { description } : {}),
      isDefault: value === config.currentValue,
    }))
  }
  return (setup.models?.availableModels ?? []).map(({ modelId, name, description }) => ({
    id: modelId,
    displayName: name,
    ...(description ? { description } : {}),
    isDefault: modelId === setup.models?.currentModelId,
  }))
}

export function withModelEffort(
  model: AgentModelInfo,
  options: SessionConfigOption[],
): AgentModelInfo {
  const config = selectConfig(options, "thought_level")
  if (!config) return model
  const efforts = configChoices(config).flatMap(({ value }) => asReasoningEffort(value) ?? [])
  return { ...model, efforts, defaultEffort: asReasoningEffort(config.currentValue) }
}

export function nativeCommands(commands: AvailableCommand[]): AgentCommandInfo[] {
  return commands.flatMap((command) => {
    const name = command.name.replace(/^[/\$]/, "")
    if (!name || /\s/.test(name) || name === "logout") return []
    const skill = command.name.startsWith("$")
    return [
      {
        name,
        text: (skill ? "$" : "/") + name,
        description: command.description,
        kind: skill ? "skill" : "builtin",
        argumentHint: command.input?.hint,
      },
    ]
  })
}

/** 思考档位由当前模型决定，逐个读取 CLI 实际提供的选项。 */
export async function readSessionModels(
  rpc: AcpProcess,
  setup: NewSessionResponse,
  signal: AbortSignal,
) {
  const models = nativeModels(setup)
  const modelConfig = selectConfig(setup.configOptions ?? [], "model")
  if (modelConfig) {
    for (const [index, model] of models.entries()) {
      if (model.id === modelConfig.currentValue) {
        models[index] = withModelEffort(model, setup.configOptions ?? [])
        continue
      }
      const result = await rpc.agent
        .request(
          "session/set_config_option",
          {
            sessionId: setup.sessionId,
            configId: modelConfig.id,
            value: model.id,
          },
          requestOptions(signal),
        )
        .catch((error: unknown) => {
          if (isAuthRequired(error) || signal?.aborted) throw error
          return null
        })
      if (result) models[index] = withModelEffort(model, result.configOptions)
    }
  }
  return models
}

export async function configureSession(
  state: { rpc: AcpProcess; nativeId: string; setup: SessionSetup },
  session: AgentSessionHandle,
  input: UserInput,
  signal: AbortSignal,
) {
  const args = { sessionId: state.nativeId }
  const options = requestOptions(signal)
  const mode = session.planMode
    ? "plan"
    : session.permissionMode === "auto" &&
        state.setup.modes?.availableModes.some((mode) => mode.id === "auto")
      ? "auto"
      : "default"
  if (session.planMode && !state.setup.modes?.availableModes.some((mode) => mode.id === "plan"))
    throw new Error("This Antigravity CLI does not provide native plan mode")
  if (state.setup.modes && mode !== state.setup.modes.currentModeId)
    await state.rpc.agent.request("session/set_mode", { ...args, modeId: mode }, options)
  let config = state.setup.configOptions ?? []
  const model = selectConfig(config, "model")
  if (
    session.model &&
    session.model !== (model?.currentValue ?? state.setup.models?.currentModelId)
  ) {
    if (model || !state.setup.models) {
      const reply = await state.rpc.agent.request(
        "session/set_config_option",
        {
          ...args,
          configId: model?.id ?? "model",
          value: session.model,
        },
        options,
      )
      config = reply.configOptions
    } else {
      await state.rpc.agent.request(
        "session/set_model",
        { ...args, modelId: session.model },
        options,
      )
    }
  }
  const thought = selectConfig(config, "thought_level")
  if (
    input.effort &&
    thought &&
    input.effort !== thought.currentValue &&
    configChoices(thought).some(({ value }) => value === input.effort)
  )
    await state.rpc.agent.request(
      "session/set_config_option",
      { ...args, configId: thought.id, value: input.effort },
      options,
    )
}

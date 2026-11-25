import {
  DEFAULT_RUNTIME_MODE,
  mobileDraftModels,
  mobileDraftOptions,
  runtimeModeSchema,
  type MobileDraftInstance,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { MobileRequestError } from "./request-error"

function enabledInstances(ctx: Context, includeComposerControls = false) {
  return ctx.agents.list().flatMap((agent) =>
    ctx.agents.listInstances(agent.id).flatMap((instance) => {
      if (!instance.enabled) return []
      const executionModes = instance.executionModes ?? agent.executionModes
      const permissionModes = executionModes?.permissions ?? runtimeModeSchema.options
      if (!permissionModes.length) return []
      const supportsPlanMode = executionModes?.plan === true
      const visible: MobileDraftInstance = {
        instanceId: instance.instanceId,
        label: instance.label,
        agentName: agent.displayName,
        permissionModes: [...permissionModes],
        defaultPermissionMode: permissionModes.includes(DEFAULT_RUNTIME_MODE)
          ? DEFAULT_RUNTIME_MODE
          : permissionModes[0]!,
        ...(includeComposerControls
          ? {
              agentId: agent.id,
              ...(instance.accentColor
                ? { accentColor: instance.accentColor.toLowerCase() }
                : {}),
              supportsPlanMode,
            }
          : {}),
      }
      return [{ agentId: agent.id, supportsPlanMode, visible }]
    }),
  )
}

function available(status: { installed: boolean; authenticated: boolean | null } | undefined) {
  return status?.installed === true && status.authenticated !== false
}

export async function draftOptions(ctx: Context, includeComposerControls = false) {
  const [detection, defaultAgent] = await Promise.all([
    ctx.agents.detect(),
    ctx.agents.defaultAgent(),
  ])
  const instances = enabledInstances(ctx, includeComposerControls)
    .map(({ visible }) => visible)
    .filter(({ instanceId }) => available(detection[instanceId]))
  const preferred = instances.find(({ instanceId }) => instanceId === defaultAgent.instanceId)
  return mobileDraftOptions.parse({
    instances,
    defaultInstanceId: (preferred ?? instances[0])?.instanceId,
  })
}

export async function draftModels(
  ctx: Context,
  instanceId: string,
  includeComposerControls = false,
) {
  const find = () =>
    enabledInstances(ctx, includeComposerControls).find(
      ({ visible }) => visible.instanceId === instanceId,
    )
  const instance = find()
  if (!instance) throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
  const detection = await ctx.agents.detect({ instanceId })
  if (!available(detection[instanceId])) throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
  const models = (await ctx.agents.models(instance.agentId, instanceId)).filter(
    ({ hidden }) => !hidden,
  )
  const current = find()
  if (!current || current.agentId !== instance.agentId) {
    throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
  }
  return {
    instance: current,
    catalog: mobileDraftModels.parse({
      models: models.map(({ id, displayName, efforts, fast, ultracode }) => ({
        id,
        label: displayName,
        ...(includeComposerControls
          ? {
              efforts: [...efforts],
              fast: fast === true,
              ultracode: ultracode === true,
            }
          : {}),
      })),
      defaultModelId: (models.find(({ isDefault }) => isDefault) ?? models[0])?.id,
    }),
  }
}

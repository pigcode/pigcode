import {
  mobileComposerMethods as methods,
  mobileSetPermissionModeParams,
  mobileSetPlanModeParams,
  mobileSwitchAgentParams,
  type MobileSetPermissionModeParams,
  type MobileSetPlanModeParams,
  type MobileSwitchAgentParams,
  type MobileThreadComposerState,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { RunAlreadyActiveError } from "../agents/errors"
import { modesForAgent, updateThreadModes } from "../agents/execution-modes"
import { requireMobileThread } from "./command-receipts"
import { buildThreadComposerState } from "./composer-state"
import { draftModels } from "./draft-catalog"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileComposerRequests: ReadonlySet<string> = new Set([
  methods.switchAgent,
  methods.setPermissionMode,
  methods.setPlanMode,
])

export class MobileComposerCommands {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
    private readonly onChanged: (threadId: string) => void,
    private readonly includeAttachments = false,
  ) {}

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.switchAgent:
        return this.switchAgent(mobileParams(mobileSwitchAgentParams, request.params))
      case methods.setPermissionMode:
        return this.setPermissionMode(mobileParams(mobileSetPermissionModeParams, request.params))
      case methods.setPlanMode:
        return this.setPlanMode(mobileParams(mobileSetPlanModeParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async switchAgent({
    threadId,
    instanceId,
    modelId,
  }: MobileSwitchAgentParams): Promise<MobileThreadComposerState> {
    requireMobileThread(this.ctx, threadId)
    if (this.ctx.agents.listRuns().some((run) => run.threadId === threadId)) {
      throw new MobileRequestError("THREAD_BUSY")
    }
    const { instance, catalog } = await draftModels(this.ctx, instanceId, true)
    this.requirePairedDevice()
    requireMobileThread(this.ctx, threadId)
    if (
      modelId !== undefined &&
      modelId !== null &&
      !catalog.models.some(({ id }) => id === modelId)
    ) {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    try {
      await this.ctx.agents.switchAgent(threadId, instance.agentId, modelId ?? null, instanceId)
    } catch (error) {
      if (error instanceof RunAlreadyActiveError) throw new MobileRequestError("THREAD_BUSY")
      if (error instanceof Error) throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
      throw error
    }
    this.onChanged(threadId)
    const composer = buildThreadComposerState(this.ctx, threadId, undefined, this.includeAttachments)
    if (!composer) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return composer
  }

  private setPermissionMode({
    threadId,
    permissionMode,
  }: MobileSetPermissionModeParams): MobileThreadComposerState {
    requireMobileThread(this.ctx, threadId)
    const thread = this.ctx.threads.get(threadId)!
    const agentId = thread.lastAgentId ?? thread.defaultAgentId
    const instanceId = thread.lastInstanceId ?? thread.defaultInstanceId ?? agentId
    const modes = modesForAgent(this.ctx, agentId, instanceId)
    if (modes?.permissions && !modes.permissions.includes(permissionMode)) {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    try {
      updateThreadModes(this.ctx, threadId, { permissionMode })
    } catch {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    this.onChanged(threadId)
    const composer = buildThreadComposerState(this.ctx, threadId, undefined, this.includeAttachments)
    if (!composer) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return composer
  }

  private setPlanMode({
    threadId,
    planMode,
  }: MobileSetPlanModeParams): MobileThreadComposerState {
    requireMobileThread(this.ctx, threadId)
    const thread = this.ctx.threads.get(threadId)!
    const agentId = thread.lastAgentId ?? thread.defaultAgentId
    const instanceId = thread.lastInstanceId ?? thread.defaultInstanceId ?? agentId
    const modes = modesForAgent(this.ctx, agentId, instanceId)
    if (planMode && !modes?.plan) {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    try {
      updateThreadModes(this.ctx, threadId, { planMode })
    } catch {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    this.onChanged(threadId)
    const composer = buildThreadComposerState(this.ctx, threadId, undefined, this.includeAttachments)
    if (!composer) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return composer
  }
}

import { randomUUID } from "node:crypto"
import {
  mobileDraftCreateParams,
  mobileDraftMethods as methods,
  mobileDraftModelParams,
  mobileDraftOptionsParams,
  mobileDraftReceipt,
  type MobileDraftCreateParams,
  type MobileDraftReceipt,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { RunQueueFullError, RunSelectionUnavailableError } from "../agents/errors"
import { commandBinding, requireMobileThread, type MobileCommandReceipts } from "./command-receipts"
import { draftModels, draftOptions } from "./draft-catalog"
import type { PairedDevices } from "./paired-devices"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileDraftRequests: ReadonlySet<string> = new Set(Object.values(methods))

export class MobileDraftCommands {
  constructor(
    private readonly ctx: Context,
    private readonly devices: PairedDevices,
    private readonly deviceKey: string,
    private readonly receipts: MobileCommandReceipts,
  ) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case methods.options:
        mobileParams(mobileDraftOptionsParams, request.params)
        return draftOptions(this.ctx)
      case methods.models: {
        const { instanceId } = mobileParams(mobileDraftModelParams, request.params)
        return (await draftModels(this.ctx, instanceId)).catalog
      }
      case methods.create:
        return this.create(mobileParams(mobileDraftCreateParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async create({
    commandId,
    projectId,
    instanceId,
    modelId,
    permissionMode,
    text,
  }: MobileDraftCreateParams): Promise<MobileDraftReceipt> {
    const permit = this.devices.runAuthorization(this.deviceKey)
    const binding = commandBinding(
      methods.create,
      projectId,
      instanceId,
      modelId ?? null,
      permissionMode,
      text,
    )
    const acceptExisting = () => {
      if (!permit()) throw new MobileRequestError("DEVICE_REVOKED")
      const receipt = this.receipts.existing(commandId, binding, mobileDraftReceipt)
      if (receipt) requireMobileThread(this.ctx, receipt.threadId)
      return receipt
    }
    const existing = acceptExisting()
    if (existing) return existing

    try {
      this.requireProject(projectId)
      const { instance, catalog } = await draftModels(this.ctx, instanceId)
      const committedWhileLoading = acceptExisting()
      if (committedWhileLoading) return committedWhileLoading
      this.requireProject(projectId)
      if (
        !instance.visible.permissionModes.includes(permissionMode) ||
        (modelId !== undefined && !catalog.models.some(({ id }) => id === modelId))
      ) {
        throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
      }

      const threadId = `th_${randomUUID()}`
      let receipt: MobileDraftReceipt | undefined
      await this.ctx.agents.startDraftRun(
        {
          threadId,
          projectId,
          instanceId,
          agentId: instance.agentId,
          modelId: modelId ?? catalog.defaultModelId ?? null,
          permissionMode,
        },
        text,
        {
          deviceKey: this.deviceKey,
          isAuthorized: permit,
          recordReceipt: (runId) => {
            const thread = this.ctx.threads.get(threadId)!
            receipt = {
              method: methods.create,
              commandId,
              projectId,
              threadId,
              title: thread.title,
              runId,
            }
            this.receipts.record(receipt, binding)
          },
        },
      )
      if (!receipt) throw new Error("missing accepted draft receipt")
      return receipt
    } catch (error) {
      const accepted = acceptExisting()
      if (accepted) return accepted
      if (error instanceof RunQueueFullError) throw new MobileRequestError("RUN_QUEUE_FULL")
      if (error instanceof RunSelectionUnavailableError) {
        throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
      }
      throw error
    }
  }

  private requireProject(projectId: string): void {
    if (!this.ctx.projects.list().some(({ id }) => id === projectId)) {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
  }
}

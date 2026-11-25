import { randomUUID } from "node:crypto"
import {
  legacyMobileDraftCreateParams,
  mobileDraftCreateParams,
  mobileDraftMethods as methods,
  mobileDraftModelParams,
  mobileDraftOptionsParams,
  mobileDraftReceipt,
  type MobileDraftCreateParams,
  type MobileDraftReceipt,
  type MobileThreadReference,
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
    private readonly supportsComposerControls = false,
    private readonly supportsAttachments = false,
  ) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case methods.options:
        mobileParams(mobileDraftOptionsParams, request.params)
        return draftOptions(this.ctx, this.supportsComposerControls, this.supportsAttachments)
      case methods.models: {
        const { instanceId } = mobileParams(mobileDraftModelParams, request.params)
        return (
          await draftModels(
            this.ctx,
            instanceId,
            this.supportsComposerControls,
            this.supportsAttachments,
          )
        ).catalog
      }
      case methods.create:
        return this.create(this.parseCreateParams(request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private parseCreateParams(input: unknown): MobileDraftCreateParams {
    if (!this.supportsComposerControls && !this.supportsAttachments) {
      return mobileParams(legacyMobileDraftCreateParams, input)
    }
    const parsed = mobileParams(mobileDraftCreateParams, input)
    if (
      !this.supportsComposerControls &&
      (parsed.effort !== undefined ||
        parsed.fast !== undefined ||
        parsed.ultracode !== undefined ||
        parsed.planMode !== undefined ||
        parsed.references !== undefined)
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    if (
      !this.supportsAttachments &&
      (parsed.attachmentIds !== undefined || !/\S/.test(parsed.text))
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    return parsed
  }

  private async create({
    commandId,
    projectId,
    instanceId,
    modelId,
    permissionMode,
    text,
    effort,
    fast,
    ultracode,
    planMode,
    references,
    attachmentIds,
  }: MobileDraftCreateParams): Promise<MobileDraftReceipt> {
    const permit = this.devices.runAuthorization(this.deviceKey)
    const extras: Record<string, unknown> = {}
    if (effort !== undefined) extras.effort = effort
    if (fast !== undefined) extras.fast = fast
    if (ultracode !== undefined) extras.ultracode = ultracode
    if (planMode !== undefined) extras.planMode = planMode
    if (references !== undefined) extras.references = references
    if (attachmentIds !== undefined) extras.attachmentIds = attachmentIds
    const binding =
      Object.keys(extras).length > 0
        ? commandBinding(
            methods.create,
            projectId,
            instanceId,
            modelId ?? null,
            permissionMode,
            text,
            extras,
          )
        : commandBinding(
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
      this.requireReferences(references)
      const { instance, catalog } = await draftModels(
        this.ctx,
        instanceId,
        this.supportsComposerControls,
      )
      const committedWhileLoading = acceptExisting()
      if (committedWhileLoading) return committedWhileLoading
      this.requireProject(projectId)
      this.requireReferences(references)
      if (
        !instance.visible.permissionModes.includes(permissionMode) ||
        (modelId !== undefined && !catalog.models.some(({ id }) => id === modelId)) ||
        (planMode === true && !instance.supportsPlanMode)
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
          ...(planMode !== undefined ? { planMode } : {}),
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
        {
          ...(effort ? { effort } : {}),
          ...(fast ? { fast: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
          ...(references && references.length > 0
            ? {
                references: references.map(({ kind, threadId: refThreadId }) => ({
                  kind,
                  threadId: refThreadId,
                })),
              }
            : {}),
          ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
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

  private requireReferences(references?: readonly MobileThreadReference[]): void {
    if (!references) return
    for (const reference of references) requireMobileThread(this.ctx, reference.threadId)
  }
}

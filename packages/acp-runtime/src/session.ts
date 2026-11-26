/** ACP 会话类型定义与无协议扩展字段依赖的纯辅助函数。 */
import { readFile } from "node:fs/promises"
import type {
  ContentBlock,
  InitializeResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import type { RuntimeMode } from "@pigcode/contracts"
import {
  appendImageAttachmentFallback,
  type AgentRuntime,
  type AgentSessionHandle,
  type CreateSessionInput,
  type UserInput,
} from "@pigcode/plugin-sdk"
import type { AcpConnectionOptions, AcpLaunch, AcpProcess } from "./connection"
import { selectConfig, type SessionSetup } from "./catalog"
import type { SessionBridge } from "./mcp"
import type { TurnEvents } from "./turn"

export type AcpTurn = {
  runtime: AgentRuntime
  events: TurnEvents
  prompting: boolean
  cancelled: boolean
  done: Promise<void>
  finish(): void
  timer?: ReturnType<typeof setTimeout>
}

export type AcpSession = {
  rpc: AcpProcess
  bridge: SessionBridge
  scope: string
  nativeId: string
  setup: SessionSetup
  liveOnly: boolean
  invocation: string
  canClose: boolean
  supportsImage: boolean
  fresh: boolean
  planMode: boolean
  normalMode: string | undefined
  policy: RuntimeMode
  release(): void
  translateError?: ((error: unknown) => unknown) | undefined
  turn?: AcpTurn | undefined
  ending?: Promise<void>
}

export interface AcpRuntimeOptions extends AcpConnectionOptions {
  sessionMeta?: Record<string, unknown>
  cancelMeta?: Record<string, unknown>
  authMethod?(launch: AcpLaunch): string | undefined
  approvalMode?(policy: RuntimeMode): RuntimeMode
  sessionPolicy?(setup: SessionSetup, mode: RuntimeMode): { id: string; value: string }
  effortId?: string
  deferredEffort?: boolean
  legacyModelEffort?: boolean
  id: string
  retainLiveOnly?: boolean
  probeModelEfforts?: boolean
  normalMode?(setup: SessionSetup, policy: RuntimeMode): string | undefined
  onInitialize?(scope: string, info: InitializeResponse): void
  onSession?(scope: string, setup: SessionSetup, info: InitializeResponse): void
}

export interface AcpLifecycle {
  release?(): void
  translateError?(error: unknown): unknown
}

export function canReuseLiveSession(
  prior: AcpSession | undefined,
  scope: string,
  nativeSessionId: string | null | undefined,
  invocation: string,
): prior is AcpSession {
  return Boolean(
    prior &&
    !prior.rpc.signal.aborted &&
    !prior.ending &&
    prior.liveOnly &&
    prior.scope === scope &&
    prior.nativeId === nativeSessionId &&
    prior.invocation === invocation,
  )
}

export function buildSessionHandle(
  id: string,
  input: CreateSessionInput,
  nativeId: string,
  permissionMode: RuntimeMode,
): AgentSessionHandle {
  return {
    id,
    threadId: input.threadId,
    cwd: input.cwd,
    nativeSessionId: nativeId,
    permissionMode,
    planMode: input.planMode ?? false,
    model: input.model ?? null,
  }
}

export function applySessionUpdate(state: AcpSession, notification: SessionNotification): void {
  const update = notification.update
  if (update.sessionUpdate === "config_option_update")
    state.setup.configOptions = update.configOptions
  if (update.sessionUpdate === "current_mode_update" && state.setup.modes)
    state.setup.modes.currentModeId = update.currentModeId
  if (!state.turn?.prompting) return
  const mode =
    update.sessionUpdate === "current_mode_update"
      ? update.currentModeId
      : update.sessionUpdate === "config_option_update"
        ? selectConfig(update.configOptions, "mode")?.currentValue
        : undefined
  if (typeof mode === "string") {
    state.planMode = mode === "plan"
    if (!state.planMode) state.normalMode = mode
    state.turn.runtime.setPlanMode?.(state.planMode)
  }
  state.turn.events.update(update)
}

export async function buildPromptPayload(
  input: UserInput,
  supportsImage: boolean,
): Promise<string | ContentBlock[]> {
  const baseText = input.handoff
    ? input.text
      ? `${input.handoff}\n\n${input.text}`
      : input.handoff
    : input.text
  const attachments = input.attachments ?? []
  if (attachments.length === 0) return baseText
  if (!supportsImage) return appendImageAttachmentFallback(baseText, attachments)
  const blocks: ContentBlock[] = []
  if (baseText.length > 0) blocks.push({ type: "text", text: baseText })
  for (const att of attachments) {
    const data = (await readFile(att.path)).toString("base64")
    blocks.push({ type: "image", mimeType: att.mimeType, data })
  }
  return blocks
}

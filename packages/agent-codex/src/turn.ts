/** Codex 单轮 turn 的通知/审批绑定与 turn/start 请求构建。 */
import type { AgentRuntime, AgentSessionHandle, UserInput } from "@pigcode/plugin-sdk"
import {
  commandApprovalChoices,
  mcpToolApproval,
  toApprovalResponse,
  toElicitationResponse,
} from "./approvals"
import type { CodexRpcClient } from "./client"
import { FAST_SERVICE_TIER } from "./models"
import { normalizeCodexNotification } from "./normalize"
import { emitNotice, mcpStartupNotice, type NoticeState } from "./notice"
import { collaborationMode, turnPermissionParams } from "./permissions"
import { injectHandoff } from "./protocol"
import { answerCodexQuestions } from "./questions"
import type { CodexTurnState } from "./turn-wait"

/** 单个 session 的 app-server 状态；权限与模型在 thread/start 或 thread/resume 时生效。 */
export interface CodexSessionState extends CodexTurnState {
  /** 本轮是否已经报过终态，用来忽略重复的 turn/completed。 */
  finished: boolean
  permissionMode: string
  model: string | null
  effectiveModel: string | null
  /** 启动这个 app-server 的命令指纹；设置改了就不再复用。 */
  launchKey: string
  scope?: string | undefined
  /** 会话提示：MCP 桥起不来时攒下来，下一次 send 时补发。 */
  notice: NoticeState
  /** 上一轮用了快速模式；turn/start 的服务档会沿用到之后的轮次，关掉时要显式清回默认。 */
  fast?: boolean
}

export type CodexTurnInputItem =
  { type: "text"; text: string } | { type: "localImage"; path: string }

/** 把通知映射后逐条交给 run 的实时事件出口。 */
function emit(runtime: AgentRuntime, method: string, params: unknown): void {
  for (const event of normalizeCodexNotification(method, params)) runtime.emit(event)
}

/** 绑定本轮 turn 的通知与服务端审批/提问回调，返回清理函数。 */
export function bindTurnHandlers(
  client: CodexRpcClient,
  state: CodexSessionState,
  runtime: AgentRuntime,
): () => void {
  // 之后才到的启动结果直接推送，同样落在本轮；同一问题只报一次。
  const watchStartup = (params: unknown): void => {
    const found = mcpStartupNotice(params)
    if (found) emitNotice(state.notice, runtime, found)
  }
  const disposeStartup = client.onNotification("mcpServer/startupStatus/updated", watchStartup)

  const disposers = [
    client.onNotification("item/agentMessage/delta", (params) =>
      emit(runtime, "item/agentMessage/delta", params),
    ),
    client.onNotification("item/completed", (params) => emit(runtime, "item/completed", params)),
    client.onNotification("item/started", (params) => emit(runtime, "item/started", params)),
    client.onNotification("item/commandExecution/outputDelta", (params) =>
      emit(runtime, "item/commandExecution/outputDelta", params),
    ),
    client.onNotification("turn/plan/updated", (params) =>
      emit(runtime, "turn/plan/updated", params),
    ),
    client.onNotification("thread/tokenUsage/updated", (params) =>
      emit(runtime, "thread/tokenUsage/updated", params),
    ),
    client.onNotification("turn/completed", (params) => {
      const events = normalizeCodexNotification("turn/completed", params)
      const ends = events.some((event) => event.type.startsWith("run."))
      // app-server 可能重复通知同一个 turn 的终态；run 的终态只报一次。
      if (ends && state.finished) return
      if (ends) state.finished = true
      for (const event of events) runtime.emit(event)
    }),
  ]
  client.onServerRequest("item/commandExecution/requestApproval", async (params) => {
    const offered = commandApprovalChoices(params)
    if (offered && !offered.decisions.length)
      throw new Error("Codex did not offer a supported approval decision")
    const decision = await runtime.requestApproval({
      toolName: "Bash",
      input: params,
      ...(offered ? { decisions: offered.decisions } : {}),
    })
    return toApprovalResponse(decision, "acceptForSession", offered?.denial)
  })
  client.onServerRequest("item/tool/requestUserInput", (params) =>
    answerCodexQuestions(params, runtime),
  )
  client.onServerRequest("item/fileChange/requestApproval", async (params) => {
    const decision = await runtime.requestApproval({ toolName: "ApplyPatch", input: params })
    return toApprovalResponse(decision, "acceptForSession")
  })
  client.onServerRequest("mcpServer/elicitation/request", async (params) => {
    const request = mcpToolApproval(params)
    // 审批卡片填不了表单，也打不开链接，这类请求只能拒绝。
    if (!request) return { action: "decline" }
    return toElicitationResponse(await runtime.requestApproval(request))
  })

  return () => {
    disposeStartup()
    for (const dispose of disposers) dispose()
  }
}

/** 构造本轮输入：交接优先经 thread/inject_items 注入，不支持时退回拼在消息前。 */
export async function buildTurnInput(
  client: CodexRpcClient,
  nativeThreadId: string,
  input: UserInput,
): Promise<CodexTurnInputItem[]> {
  // 交接优先用 thread/inject_items 作为历史消息注入，用户这一轮的消息保持原文；
  // 不支持时（旧版 app-server）退回拼在用户消息前（#82）。
  const injected = input.handoff
    ? await injectHandoff(client, nativeThreadId, input.handoff)
    : false
  const text =
    input.handoff && !injected
      ? input.text
        ? `${input.handoff}\n\n${input.text}`
        : input.handoff
      : input.text
  const attachments = input.attachments ?? []
  return [
    ...(text.length > 0 || attachments.length === 0 ? [{ type: "text" as const, text }] : []),
    ...attachments.map((att) => ({ type: "localImage" as const, path: att.path })),
  ]
}

/** 构造 turn/start 请求参数。 */
export function buildTurnStartParams(
  session: AgentSessionHandle,
  state: CodexSessionState,
  nativeThreadId: string,
  input: UserInput,
  turnInput: CodexTurnInputItem[],
): Record<string, unknown> {
  return {
    threadId: nativeThreadId,
    input: turnInput,
    ...collaborationMode(session.planMode === true, state.effectiveModel, input.effort),
    ...turnPermissionParams(session.permissionMode, session.cwd),
    // 思考深度只对本轮及之后的轮次生效；没有选择时沿用 Codex 的默认值。
    ...(input.effort ? { effort: input.effort } : {}),
    // 服务档和思考深度一样会沿用；选了快速发 fast，从快速切回标准时发 null 回到默认档。
    ...(input.fast ? { serviceTier: FAST_SERVICE_TIER } : state.fast ? { serviceTier: null } : {}),
  }
}

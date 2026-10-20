/** Claude Code adapter；SDK 负责进程、流式与权限回调。 */
import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProviderCapabilities } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateSessionInput,
  ProviderDriver,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "../driver"
import { createNormalizeState, normalizeSdkMessage } from "./normalize"

/** 可注入的 query 实现，便于测试替换真实 CLI 进程。 */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => Query

/** driver 的可选依赖；测试可替换 query 与 CLI 可执行文件路径。 */
export interface ClaudeDriverOptions {
  queryFn?: ClaudeQueryFn
  executable?: string
}

/** 基于 @anthropic-ai/claude-agent-sdk 的 Claude Code provider。 */
export class ClaudeDriver implements ProviderDriver {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    questions: false,
    plan: true,
    resume: true,
    fork: false,
    rollback: false,
    checkpoint: false,
    subagents: true,
    mcp: true,
    images: true,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly queryFn: ClaudeQueryFn
  private readonly executable: string | undefined

  constructor(options: ClaudeDriverOptions = {}) {
    this.queryFn = options.queryFn ?? query
    this.executable = options.executable
  }

  /** 创建内存句柄；原生会话在首次 send 后由 SDK init 消息补充。 */
  async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    return {
      id: `claude_${randomUUID()}`,
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId ?? null,
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 发起一次 query，并把 SDK 消息逐个归一化为 provider 事件。 */
  async send(
    session: ProviderSessionHandle,
    input: UserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
    const state = createNormalizeState()
    const queryStream = this.queryFn({
      prompt: input.text,
      options: {
        cwd: session.cwd,
        ...(session.nativeSessionId ? { resume: session.nativeSessionId } : {}),
        includePartialMessages: true,
        ...(this.executable ? { pathToClaudeCodeExecutable: this.executable } : {}),
        permissionMode: mapPermissionMode(session.permissionMode),
        ...(session.permissionMode === "danger-full-access"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        canUseTool: async (toolName, toolInput, options) => {
          const request: ApprovalRequest = { toolName, input: toolInput }
          if (options.title !== undefined) request.title = options.title
          if (options.displayName !== undefined) request.displayName = options.displayName
          if (options.description !== undefined) request.description = options.description
          if (options.blockedPath !== undefined) request.blockedPath = options.blockedPath
          if (options.suggestions !== undefined) request.suggestions = options.suggestions
          const decision = await runtime.requestApproval(request)
          return toPermissionResult(decision, toolName, options.suggestions)
        },
      },
    })
    try {
      for await (const message of queryStream) {
        for (const event of normalizeSdkMessage(message, state)) runtime.emit(event)
      }
    } catch (error) {
      runtime.emit({
        type: "run.failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 中断能力在 Task 8 接入当前 Query 后实现。 */
  async interrupt(): Promise<void> {}

  /** 会话由 SDK 子进程自行结束，此处无需释放资源。 */
  async dispose(): Promise<void> {}
}

/** 把 Pigcode 权限模式映射到 Claude SDK 的 permissionMode。 */
function mapPermissionMode(mode: string): NonNullable<Options["permissionMode"]> {
  switch (mode) {
    case "read-only":
      return "plan"
    case "danger-full-access":
      return "bypassPermissions"
    case "plan":
      return "plan"
    default:
      return "default"
  }
}

/** 把审批决议转换为 canUseTool 需要的 PermissionResult。 */
function toPermissionResult(
  decision: ApprovalDecision,
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  if (decision === "deny") return { behavior: "deny", message: "用户拒绝了这次工具调用" }
  if (decision === "allow-for-session") {
    return {
      behavior: "allow",
      updatedPermissions: suggestions ?? [
        { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
      ],
    }
  }
  return { behavior: "allow" }
}

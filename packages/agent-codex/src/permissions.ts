import {
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  type AgentExecutionModes,
  type ReasoningEffort,
} from "@pigcode/contracts"
import type { CreateSessionInput } from "@pigcode/plugin-sdk"

export const codexExecutionModes: AgentExecutionModes = { plan: true }

/** start/resume/fork 始终显式设置审批者，退出自动审批后不会沿用旧 reviewer。 */
export function createThreadParams(input: CreateSessionInput): Record<string, unknown> {
  const config = codexPermissionConfig(input.permissionMode)
  const model = input.model ?? process.env.PIGCODE_CODEX_MODEL
  return {
    cwd: input.cwd,
    ...config,
    ...(model ? { model } : {}),
    ...(input.mcp ? { config: { mcp_servers: { pigcode: input.mcp.stdioServer() } } } : {}),
  }
}

export function codexPermissionConfig(value = DEFAULT_RUNTIME_MODE as string) {
  const mode = normalizeRuntimeMode(value, "codex")
  if (!mode) throw new Error(`Unsupported Codex permission mode: ${value}`)
  return {
    approvalPolicy:
      mode === "approval-required" ? "untrusted" : mode === "full-access" ? "never" : "on-request",
    approvalsReviewer: mode === "auto" ? "auto_review" : "user",
    sandbox:
      mode === "approval-required"
        ? "read-only"
        : mode === "full-access"
          ? "danger-full-access"
          : "workspace-write",
  }
}

/** 每轮显式覆盖权限，避免原生会话继续沿用上一档的审批者或沙箱。 */
export function turnPermissionParams(mode: string, cwd: string) {
  const config = codexPermissionConfig(mode)
  return {
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy:
      config.sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : config.sandbox === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
  }
}

export function collaborationMode(plan: boolean, model: string | null, effort?: ReasoningEffort) {
  if (!model) {
    if (plan) throw new Error("Codex did not report a model for plan mode")
    return {}
  }
  return {
    collaborationMode: {
      mode: plan ? "plan" : "default",
      settings: { model, reasoning_effort: effort ?? null, developer_instructions: null },
    },
  }
}

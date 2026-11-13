import type { AgentPermissionMode } from "./agents"
import { runtimeModeMessages } from "./locale/runtime-modes"

/** 所有 Agent 的菜单、说明、图标和顺序共用这一份平台定义。 */
export const RUNTIME_MODE_OPTIONS: readonly AgentPermissionMode[] = [
  {
    id: "approval-required",
    kind: "ask",
    command: "ask",
    ...runtimeModeMessages["approval-required"],
  },
  {
    id: "auto-accept-edits",
    kind: "edit",
    command: "accept-edits",
    ...runtimeModeMessages["auto-accept-edits"],
  },
  { id: "auto", kind: "auto", command: "auto", ...runtimeModeMessages.auto },
  {
    id: "full-access",
    kind: "full-access",
    requiresConfirmation: true,
    ...runtimeModeMessages["full-access"],
  },
]

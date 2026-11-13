import type { LocalizedText } from "../agents"
import type { RuntimeMode } from "../runtime-modes"

export const runtimeModeMessages: Record<
  RuntimeMode,
  { label: LocalizedText; description: LocalizedText }
> = {
  "approval-required": {
    label: { "zh-CN": "监督审批", "en-US": "Supervised" },
    description: {
      "zh-CN": "需要授权的命令和修改由你审批",
      "en-US": "Ask you about commands and edits that require approval",
    },
  },
  "auto-accept-edits": {
    label: { "zh-CN": "接受编辑", "en-US": "Auto-accept edits" },
    description: {
      "zh-CN": "自动接受编辑，其余操作按需审批",
      "en-US": "Accept edits automatically; ask about other actions as needed",
    },
  },
  auto: {
    label: { "zh-CN": "自动审批", "en-US": "Auto" },
    description: {
      "zh-CN": "Agent 自动审查操作，不支持时使用监督审批",
      "en-US": "The agent reviews actions; use supervised mode when unavailable",
    },
  },
  "full-access": {
    label: { "zh-CN": "完全访问", "en-US": "Full access" },
    description: {
      "zh-CN": "允许 Agent 直接执行命令和修改文件",
      "en-US": "Allow the agent to run commands and edit files directly",
    },
  },
}

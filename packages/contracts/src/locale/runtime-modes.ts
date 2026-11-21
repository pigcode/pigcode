import type { LocalizedText } from "../agents"
import type { RuntimeMode } from "../runtime-modes"

export const runtimeModeMessages: Record<
  RuntimeMode,
  { label: LocalizedText; description: LocalizedText }
> = {
  "approval-required": {
    label: { "zh-CN": "先问我", "en-US": "Ask first" },
    description: {
      "zh-CN": "要改文件或跑命令时，先问你",
      "en-US": "Asks you before editing files or running commands",
    },
  },
  "auto-accept-edits": {
    label: { "zh-CN": "自动改文件", "en-US": "Auto-edit" },
    description: {
      "zh-CN": "直接改文件，别的事先问你",
      "en-US": "Edits files right away and asks about the rest",
    },
  },
  auto: {
    label: { "zh-CN": "自动判断", "en-US": "Auto" },
    description: {
      "zh-CN": "Agent 自己判断要不要问你，做不到时先问你",
      "en-US": "The agent decides when to ask. If it can't, it asks first",
    },
  },
  "full-access": {
    label: { "zh-CN": "完全访问", "en-US": "Full access" },
    description: {
      "zh-CN": "不问你，直接改文件、跑命令",
      "en-US": "Edits files and runs commands without asking",
    },
  },
}

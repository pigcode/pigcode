import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  settingString,
  settingEnvironment,
  type AgentRuntime,
  type AgentSettingsValues,
  type UserInput,
} from "@pigcode/plugin-sdk"

import { resumeReturnLabels } from "./locale/compaction"

/** 每轮把实例配置作为 SDK 覆盖层，保留 CLI 文件和其它会话选项。 */
export function claudeQueryPreferences(
  settings: AgentSettingsValues | undefined,
  input: UserInput,
  runtime: AgentRuntime,
): Pick<Options, "settings" | "onUserDialog" | "supportedDialogKinds"> {
  const text = settingString(settings, "autoCompactWindow")
  if (text && !/^(?:[1-9]\d{5}|1000000)$/.test(text))
    throw new Error("Claude auto-compact window must be between 100000 and 1000000 tokens")
  const idleOff = settings?.idleCompaction === "off"
  const ask = runtime.askQuestions
  const overrides = {
    ...(input.fast ? { fastMode: true } : {}),
    ...(input.ultracode ? { ultracode: true, enableWorkflows: true } : {}),
    ...(text
      ? { autoCompactWindow: Number(text), env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: text } }
      : {}),
    ...(idleOff ? { idleCompaction: false } : {}),
  }
  return {
    ...(Object.keys(overrides).length ? { settings: overrides } : {}),
    ...(ask
      ? {
          supportedDialogKinds: ["resume_return"],
          onUserDialog: async (request, { signal }) => {
            if (request.dialogKind !== "resume_return") return null
            if (signal.aborted || runtime.signal.aborted) return { behavior: "cancelled" }
            const { estimatedTokens, sessionAgeMinutes } = request.payload
            if (
              idleOff ||
              input.text.trim() === "/compact" ||
              typeof estimatedTokens !== "number" ||
              !Number.isFinite(estimatedTokens) ||
              estimatedTokens < 200_000
            )
              return { behavior: "completed", result: "continue" }
            const minutes =
              typeof sessionAgeMinutes === "number" && Number.isFinite(sessionAgeMinutes)
                ? Math.max(0, Math.floor(sessionAgeMinutes))
                : 0
            const locale =
              settingEnvironment(settings).find(({ name }) => name === "LANG")?.value ??
              Intl.NumberFormat().resolvedOptions().locale
            const labels = resumeReturnLabels(locale)
            const { compact, keep, never } = labels
            const answers = await ask(
              {
                questions: [
                  {
                    header: labels.header,
                    question: labels.question(
                      minutes,
                      Math.floor(estimatedTokens).toLocaleString("en-US"),
                    ),
                    options: [{ label: compact }, { label: keep }, { label: never }],
                    multiSelect: false,
                    allowCustomAnswer: false,
                  },
                ],
              },
              signal,
            )
            if (signal.aborted || runtime.signal.aborted || !answers.length)
              return { behavior: "cancelled" }
            return {
              behavior: "completed",
              result:
                answers[0] === compact ? "compact" : answers[0] === never ? "never" : "continue",
            }
          },
        }
      : {}),
  }
}

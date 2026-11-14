/** 把当前 Agent 的命令和 Skill 接入输入框。 */
import { useMemo } from "react"
import type { AgentCommand } from "@pigcode/contracts"
import type { ComposerCommand } from "./composer-editor"

export type AgentCommandLoader = (
  instanceId: string,
  refresh?: boolean,
) => Promise<readonly AgentCommand[]>

/** Agent 命令转成输入框命令：选中后插入它的文字，随消息发给 CLI。 */
export function toComposerCommands(commands: readonly AgentCommand[]): ComposerCommand[] {
  return commands.map((command) => ({
    id: `agent:${command.text}`,
    label: command.text,
    description: command.shortDescription ?? command.description,
    keywords: [command.name, command.displayName, command.scope].filter((value): value is string =>
      Boolean(value),
    ),
    hint: command.argumentHint,
    insert: command.text,
    source: command.kind,
    ...(command.kind === "skill" ? { skill: command } : {}),
  }))
}

/** 绑定当前实例的读取函数，包成输入框要的形状；读不到时是空列表。缓存由调用方负责。 */
export function useAgentCommandSource(
  instanceId: string | null,
  load: AgentCommandLoader | undefined,
): ((refresh?: boolean) => Promise<readonly ComposerCommand[]>) | undefined {
  return useMemo(
    () =>
      load && instanceId
        ? (refresh) =>
            (refresh ? load(instanceId, true) : load(instanceId)).then(
              toComposerCommands,
              (): ComposerCommand[] => [],
            )
        : undefined,
    [load, instanceId],
  )
}

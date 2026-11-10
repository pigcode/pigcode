/** 当前 Agent 的 `/` 命令（CLI 内置命令、skill 与自定义命令）接进输入框的命令列表。 */
import { useMemo } from "react"
import type { AgentCommand } from "@pigcode/contracts"
import type { ComposerCommand } from "./composer-editor"

/** Agent 命令转成输入框命令：选中后插入它的文字，随消息发给 CLI。 */
export function toComposerCommands(commands: readonly AgentCommand[]): ComposerCommand[] {
  return commands.map((command) => ({
    id: `agent:${command.text}`,
    label: command.text,
    description: command.description,
    hint: command.argumentHint,
    insert: command.text,
    source: command.kind,
  }))
}

/** 绑定当前实例的读取函数，包成输入框要的形状；读不到时是空列表。缓存由调用方负责。 */
export function useAgentCommandSource(
  instanceId: string | null,
  load: ((instanceId: string) => Promise<readonly AgentCommand[]>) | undefined,
): (() => Promise<readonly ComposerCommand[]>) | undefined {
  return useMemo(
    () =>
      load && instanceId
        ? () => load(instanceId).then(toComposerCommands, (): ComposerCommand[] => [])
        : undefined,
    [load, instanceId],
  )
}

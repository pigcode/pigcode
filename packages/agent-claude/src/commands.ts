/**
 * Claude Code 的 `/` 命令：内置命令、skill、插件命令与自定义命令。
 *
 * SDK 会话的 supportedCommands() 就是 CLI 在这个工作目录下认得的全部命令（项目级 skill 在
 * `<cwd>/.claude/skills`），内置命令带 builtin 标记。读一次要启动 CLI，一秒左右，会话不发送消息。
 * 选中后插入 `/名字`，CLI 收到以斜杠开头的消息时自己展开。
 */
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentCommandInfo } from "@pigcode/plugin-sdk"
import { idleInput, withTimeout, type ClaudeModelSource } from "./models"

/** 读命令需要的依赖；和模型目录共用 query 与检测，另外带上工作目录。 */
export type ClaudeCommandSource = Pick<
  ClaudeModelSource,
  "queryFn" | "executable" | "env" | "detect"
> & {
  cwd: string | null
  timeoutMs?: number
}

/** SDK 的命令转成目录条目；CLI 内部用的命令（名字以下划线开头）不列。 */
export function parseClaudeCommands(commands: readonly SlashCommand[]): AgentCommandInfo[] {
  return commands.flatMap((command): AgentCommandInfo[] => {
    const name = command.name?.trim()
    if (!name || name.startsWith("_")) return []
    return [
      {
        name,
        text: `/${name}`,
        description: command.description || undefined,
        argumentHint: command.argumentHint || undefined,
        kind: command.builtin ? "builtin" : "skill",
      },
    ]
  })
}

/** 读取 Claude Code 在 cwd 下的命令；CLI 没装、没登录或超时都返回空列表。 */
export async function listClaudeCommands(source: ClaudeCommandSource): Promise<AgentCommandInfo[]> {
  const detection = await source.detect().catch(() => ({ installed: false, loggedIn: false }))
  if (!detection.installed || !detection.loggedIn) return []
  const input = idleInput()
  let stream: ReturnType<ClaudeCommandSource["queryFn"]> | undefined
  try {
    stream = source.queryFn({
      prompt: input.iterable,
      options: {
        ...(source.executable ? { pathToClaudeCodeExecutable: source.executable } : {}),
        ...(source.cwd ? { cwd: source.cwd } : {}),
        ...(source.env ? { env: source.env } : {}),
      },
    })
    return parseClaudeCommands(
      await withTimeout(stream.supportedCommands(), source.timeoutMs ?? 15_000),
    )
  } catch {
    return []
  } finally {
    input.close()
    stream?.close()
  }
}

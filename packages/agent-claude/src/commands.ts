/**
 * Claude Code 的 `/` 命令：内置命令、skill、插件命令与自定义命令。
 *
 * SDK 提供斜杠命令，系统、用户、项目和插件的本地 Skill 另进入 `$` 目录。
 * 目录查询不发送消息。
 */
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentCommandInfo } from "@pigcode/plugin-sdk"
import { idleInput, withTimeout, type ClaudeModelSource } from "./models"
import { CLAUDE_SETTING_SOURCES } from "./launch"
import { discoverClaudeSkills } from "./skills"

/** 读命令需要的依赖；和模型目录共用 query 与检测，另外带上工作目录。 */
export type ClaudeCommandSource = Pick<
  ClaudeModelSource,
  "queryFn" | "executable" | "env" | "detect"
> & {
  cwd: string | null
  timeoutMs?: number
  extraArgs?: Record<string, string | null>
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

/** 本地 Skill 不依赖登录；SDK 目录只做初始化，不发送消息，不连接 MCP。 */
export async function listClaudeCommands(source: ClaudeCommandSource): Promise<AgentCommandInfo[]> {
  const skills = await discoverClaudeSkills(source)
  const detection = await source.detect().catch(() => ({ installed: false, loggedIn: false }))
  if (!detection.installed) return skills
  const input = idleInput()
  let stream: ReturnType<ClaudeCommandSource["queryFn"]> | undefined
  try {
    stream = source.queryFn({
      prompt: input.iterable,
      options: {
        ...(source.executable ? { pathToClaudeCodeExecutable: source.executable } : {}),
        ...(source.cwd ? { cwd: source.cwd } : {}),
        env: { ...(source.env ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        ...(source.extraArgs ? { extraArgs: source.extraArgs } : {}),
        settingSources: [...CLAUDE_SETTING_SOURCES],
        persistSession: false,
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
      },
    })
    return [
      ...skills,
      ...parseClaudeCommands(
        await withTimeout(stream.supportedCommands(), source.timeoutMs ?? 15_000),
      ),
    ]
  } catch {
    return skills
  } finally {
    input.close()
    stream?.close()
  }
}

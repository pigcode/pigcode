import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { UserInput } from "@pigcode/plugin-sdk"
import { discoverClaudeSkills, type ClaudeSkill } from "./skills"
import type { ClaudeSkillSource } from "./skill-roots"

const SKILL_MENTION =
  /(^|\s)\$(?!\d[\d_]*(?:[kKmMbBtT]|[eE]\d+)?(?:\s|$))([a-zA-Z0-9][\w.:-]*)(?=\s|$)/g

interface SkillMention {
  skill: ClaudeSkill
  start: number
  end: number
}

/** Claude 只原生展开最后一个文本块开头的一条命令。前一块保留完整的用户请求。 */
export function claudePrompt(
  input: UserInput,
  source: ClaudeSkillSource,
): string | AsyncIterable<SDKUserMessage> {
  const prefix = input.handoff ? input.handoff + "\n\n" : ""
  const matches = [...input.text.matchAll(SKILL_MENTION)]
  // 显式以 / 开头时，交给 Claude 直接执行该命令。
  if (matches.length === 0 || /^\/[^/\s]+(?:\s|$)/.test(input.text.trimStart())) {
    return prefix + input.text
  }
  return skillMessage(input.text, prefix, matches, source)
}

async function* skillMessage(
  text: string,
  prefix: string,
  matches: RegExpMatchArray[],
  source: ClaudeSkillSource,
): AsyncGenerator<SDKUserMessage> {
  const skills = new Map((await discoverClaudeSkills(source)).map((skill) => [skill.name, skill]))
  const mentions = matches.flatMap((match): SkillMention[] => {
    const skill = skills.get(match[2] ?? "")
    if (!skill || match.index === undefined) return []
    return [
      {
        skill,
        start: match.index + (match[1]?.length ?? 0),
        end: match.index + match[0].length,
      },
    ]
  })
  const last = mentions.at(-1)
  const content = last ? skillBlocks(text, prefix, mentions, last) : prefix + text
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null }
}

function skillBlocks(
  text: string,
  prefix: string,
  mentions: SkillMention[],
  last: SkillMention,
): Exclude<SDKUserMessage["message"]["content"], string> {
  let leading = prefix
  let cursor = 0
  const annotated = new Set([last.skill.name])
  for (const { skill, start, end } of mentions) {
    leading += text.slice(cursor, start) + "/" + skill.name
    if (skill.userInvocationOnly && !annotated.has(skill.name)) {
      leading += " [Apply the Skill the user selected from " + skill.path + ".]"
      annotated.add(skill.name)
    }
    cursor = end
  }
  leading += text.slice(cursor)
  const command = "/" + last.skill.name + text.slice(last.end)
  const content: Exclude<SDKUserMessage["message"]["content"], string> = []
  if ((prefix + text.slice(0, last.start)).trim()) {
    content.push({ type: "text", text: leading.trimEnd() })
  }
  content.push({ type: "text", text: command.trimEnd() })

  return content
}

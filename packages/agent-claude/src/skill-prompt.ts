import { readFile } from "node:fs/promises"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { UserImageAttachment, UserInput } from "@pigcode/plugin-sdk"
import { discoverClaudeSkills, type ClaudeSkill } from "./skills"
import type { ClaudeSkillSource } from "./skill-roots"

const SKILL_MENTION =
  /(^|\s)\$(?!\d[\d_]*(?:[kKmMbBtT]|[eE]\d+)?(?:\s|$))([a-zA-Z0-9][\w.:-]*)(?=\s|$)/g

interface SkillMention {
  skill: ClaudeSkill
  start: number
  end: number
}

type ContentBlocks = Exclude<SDKUserMessage["message"]["content"], string>

/** Claude 只原生展开最后一个文本块开头的一条命令。前一块保留完整的用户请求；图片块放在文本块之前。 */
export function claudePrompt(
  input: UserInput,
  source: ClaudeSkillSource,
): string | AsyncIterable<SDKUserMessage> {
  const prefix = input.handoff ? input.handoff + "\n\n" : ""
  const attachments = input.attachments ?? []
  const matches = [...input.text.matchAll(SKILL_MENTION)]
  const explicitCommand = /^\/[^/\s]+(?:\s|$)/.test(input.text.trimStart())
  // 无图片且不涉及 Skill 展开时直接传字符串。
  if (attachments.length === 0 && (matches.length === 0 || explicitCommand)) {
    return prefix + input.text
  }
  return streamedMessage(input.text, input.handoff, prefix, attachments, explicitCommand ? [] : matches, source)
}

async function* streamedMessage(
  text: string,
  handoff: string | undefined,
  prefix: string,
  attachments: ReadonlyArray<UserImageAttachment>,
  matches: RegExpMatchArray[],
  source: ClaudeSkillSource,
): AsyncGenerator<SDKUserMessage> {
  const imageBlocks: ContentBlocks = await Promise.all(
    attachments.map(async (att) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: att.mimeType,
        data: (await readFile(att.path)).toString("base64"),
      },
    })),
  )

  let mentions: SkillMention[] = []
  if (matches.length > 0) {
    const skills = new Map((await discoverClaudeSkills(source)).map((skill) => [skill.name, skill]))
    mentions = matches.flatMap((match): SkillMention[] => {
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
  }
  const last = mentions.at(-1)
  if (imageBlocks.length === 0) {
    const content = last ? skillBlocks(text, prefix, mentions, last) : prefix + text
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null }
    return
  }

  const textBlocks: ContentBlocks = last
    ? skillBlocks(text, prefix, mentions, last)
    : (() => {
        const combined = handoff ? (text ? `${handoff}\n\n${text}` : handoff) : text
        return combined.length > 0 ? [{ type: "text", text: combined }] : []
      })()
  yield {
    type: "user",
    message: { role: "user", content: [...imageBlocks, ...textBlocks] },
    parent_tool_use_id: null,
  }
}

function skillBlocks(
  text: string,
  prefix: string,
  mentions: SkillMention[],
  last: SkillMention,
): ContentBlocks {
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

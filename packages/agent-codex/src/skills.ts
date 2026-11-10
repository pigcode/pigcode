/**
 * Codex 的 skill：app-server 的 `skills/list` 按工作目录列出用户级、项目级与插件带的 skill。
 * Codex 没有可以经 app-server 列出的斜杠命令，所以 `/` 菜单里只有 skill。选中后插入 `$名字`，
 * 和 Codex 自己的输入框一样，由 CLI 在消息里认出 skill。
 */
import type { AgentCommandInfo } from "@pigcode/plugin-sdk"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** `skills/list` 的返回转成目录条目；停用的 skill 不列，同名的只留第一个。 */
export function parseCodexSkills(value: unknown, cwd: string | null): AgentCommandInfo[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data.filter(isRecord) : []
  // 返回按工作目录分组；只要请求的那个目录，找不到时合并全部。
  const matching = cwd ? data.filter((entry) => entry.cwd === cwd) : []
  const entries = matching.length > 0 ? matching : data
  const seen = new Set<string>()
  const result: AgentCommandInfo[] = []
  for (const entry of entries) {
    const skills = Array.isArray(entry.skills) ? entry.skills.filter(isRecord) : []
    for (const skill of skills) {
      const name = text(skill.name)
      if (!name || skill.enabled === false || seen.has(name)) continue
      seen.add(name)
      const ui = isRecord(skill.interface) ? skill.interface : {}
      result.push({
        name,
        text: `$${name}`,
        description:
          text(ui.shortDescription) ?? text(skill.shortDescription) ?? text(skill.description),
        kind: "skill",
      })
    }
  }
  return result
}

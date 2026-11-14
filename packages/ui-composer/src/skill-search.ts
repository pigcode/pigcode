/** Skill 按调用名、展示名、描述和作用域搜索；名称的精确命中优先，完整目录不截断。 */
import type { ComposerCommand } from "./composer-editor"
import { fuzzyScore } from "./fuzzy"

function rank(value: string | undefined, query: string, base: number, fuzzy = false): number {
  if (!value) return Infinity
  const text = value.toLocaleLowerCase()
  if (text === query) return base
  if (text.startsWith(query)) return base + 2
  if (text.split(/[\s:._/-]+/).some((word) => word.startsWith(query))) return base + 4
  if (text.includes(query)) return base + 6
  const score = fuzzy ? fuzzyScore(text, query) : -1
  return score >= 0 ? 100 + base + 1 / (1 + score) : Infinity
}

export function searchCommands(
  commands: readonly ComposerCommand[],
  input: string,
): ComposerCommand[] {
  const query = input
    .trim()
    .replace(/^[$/]+/, "")
    .toLocaleLowerCase()
  if (!query) return [...commands]
  return commands
    .map((command) => ({
      command,
      score: Math.min(
        rank(command.skill?.name ?? command.label.replace(/^[$/]/, ""), query, 0, true),
        rank(command.skill?.displayName, query, 1, true),
        rank(command.skill?.shortDescription, query, 20),
        rank(command.skill?.description ?? command.description, query, 30),
        rank(command.skill?.scope, query, 40),
        ...(command.keywords ?? []).map((keyword) => rank(keyword, query, 10, true)),
      ),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.command)
}

export function searchSkills(
  commands: readonly ComposerCommand[],
  input: string,
): ComposerCommand[] {
  return searchCommands(
    commands.filter((command) => command.source === "skill" && command.insert?.startsWith("$")),
    input,
  )
}

export function skillLabel(command: ComposerCommand): string {
  return command.skill?.displayName ?? command.skill?.name ?? command.label
}

/** CLI 的来源字段映射为界面已有的简短标签。 */
export function skillScope(
  command: ComposerCommand,
): "project" | "user" | "plugin" | "system" | undefined {
  const skill = command.skill
  if (!skill) return undefined
  if (
    skill.pluginId ||
    /[/\\](?:\.codex|\.agents|\.claude)[/\\]plugins[/\\]/.test(skill.path ?? "")
  )
    return "plugin"
  if (["repo", "project", "workspace", "local"].includes(skill.scope ?? "")) return "project"
  if (["user", "personal"].includes(skill.scope ?? "")) return "user"
  return skill.scope === "system" ? "system" : undefined
}

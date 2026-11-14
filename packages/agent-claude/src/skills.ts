/** Claude 的本地 Skill 目录，供输入框和发送时的原生命令共用。 */
import type { AgentCommandInfo } from "@pigcode/plugin-sdk"
import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { parse } from "yaml"
import { claudeSkillRoots, type ClaudeSkillSource, type SkillRoot } from "./skill-roots"

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const SKILL_NAME = /^(?=[\w.:-]*[a-zA-Z])[a-zA-Z0-9][\w.:-]*$/

export interface ClaudeSkill extends AgentCommandInfo {
  kind: "skill"
  path: string
  userInvocable: boolean
  userInvocationOnly: boolean
}

function frontmatterFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  if (["true", "yes", "on", "y"].includes(text)) return true
  if (["false", "no", "off", "n"].includes(text)) return false
  return undefined
}

function metadata(contents: string): Record<string, unknown> | null {
  const match = FRONTMATTER.exec(contents)
  if (!match) return contents.trimStart().startsWith("---") ? null : {}
  const input = match[1] ?? ""
  const read = (yaml: string): Record<string, unknown> | null => {
    const value: unknown = parse(yaml)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  try {
    return read(input)
  } catch {
    // Claude 允许描述带未加引号的冒号。
    const repaired = input.replace(
      /^(description:[ \t]*)([^\r\n]+)/gm,
      (line, key: string, value: string) =>
        /^[\w\u0080-\uFFFF].*:[ \t]/.test(value) ? key + JSON.stringify(value) : line,
    )
    if (repaired === input) return null
    try {
      return read(repaired)
    } catch {
      return null
    }
  }
}

function parseSkill(
  root: SkillRoot,
  folder: string,
  path: string,
  contents: string,
  single: boolean,
): ClaudeSkill | null {
  const data = metadata(contents)
  if (!data) return null
  const title = typeof data.name === "string" ? data.name.trim() : ""
  const prefix = root.plugin ? root.plugin.name + ":" : ""
  const declared = title.startsWith(prefix) ? title.slice(prefix.length) : title
  const name = root.plugin
    ? prefix + (single && declared ? declared : folder).replace(/[^a-zA-Z0-9_-]/g, "-")
    : folder
  if (!SKILL_NAME.test(name)) return null
  return {
    name,
    text: "$" + name,
    kind: "skill",
    description: typeof data.description === "string" ? data.description.trim() : undefined,
    displayName: title && title !== name && title !== folder ? title : undefined,
    path,
    scope: root.scope,
    pluginId: root.plugin?.id,
    userInvocable: frontmatterFlag(data["user-invocable"]) !== false,
    userInvocationOnly: frontmatterFlag(data["disable-model-invocation"]) === true,
  }
}

async function readRoot(root: SkillRoot): Promise<ClaudeSkill[]> {
  if (root.plugin) {
    const path = join(root.directory, "SKILL.md")
    const contents = await readFile(path, "utf8").catch(() => null)
    if (contents !== null) {
      const skill = parseSkill(root, basename(root.directory), path, contents, true)
      return skill ? [skill] : []
    }
  }
  const entries = await readdir(root.directory).catch((): string[] => [])
  const skills = await Promise.all(
    entries.sort().map(async (entry) => {
      const path = join(root.directory, entry, "SKILL.md")
      const contents = await readFile(path, "utf8").catch(() => null)
      return contents === null ? null : parseSkill(root, entry, path, contents, false)
    }),
  )
  return skills.filter((skill) => skill !== null)
}

/** 与 T3 Code 一样按系统、用户、项目的顺序保留第一个同名条目。 */
export async function discoverClaudeSkills(source: ClaudeSkillSource): Promise<ClaudeSkill[]> {
  const { roots, overrides } = await claudeSkillRoots(source)
  const skills = new Map<string, ClaudeSkill>()
  for (const list of await Promise.all(roots.map(readRoot))) {
    for (const skill of list) {
      if (skills.has(skill.name)) continue
      const override = skill.pluginId ? undefined : overrides.get(skill.name)
      skills.set(skill.name, {
        ...skill,
        userInvocable: skill.userInvocable && override !== "off",
        userInvocationOnly: skill.userInvocationOnly || override === "user-invocable-only",
      })
    }
  }
  return [...skills.values()]
    .filter((skill) => skill.userInvocable)
    .sort((left, right) => left.name.localeCompare(right.name))
}

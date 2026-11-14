import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverClaudeSkills } from "./skills"
import { listClaudeCommands } from "./commands"
import { claudePrompt } from "./skill-prompt"

let root: string
let config: string
let cwd: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pigcode-skills-")))
  config = join(root, "config")
  cwd = join(root, "workspace")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function skill(directory: string, folder: string, contents: string) {
  const path = join(directory, "skills", folder, "SKILL.md")
  await mkdir(join(directory, "skills", folder), { recursive: true })
  await writeFile(path, contents)
  return path
}

describe("Claude skill discovery", () => {
  it("keeps user skills ahead of same-named project skills and uses native directory names", async () => {
    const userPath = await skill(
      config,
      "ask-matt",
      "---\nname: ask-matt\ndescription: User copy\n---\n",
    )
    await skill(config, "fallback-name", "Instructions without frontmatter")
    const path = await skill(
      join(cwd, ".claude"),
      "router",
      "---\nname: ask-matt\ndescription: >\n  Choose the right\n  Matt Pocock workflow\n---\n",
    )
    await skill(join(cwd, ".claude"), "ask-matt", "---\ndescription: Project copy\n---\n")
    const skills = await discoverClaudeSkills({ cwd, env: { CLAUDE_CONFIG_DIR: config } })
    expect(skills).toHaveLength(3)
    expect(skills[0]).toMatchObject({ name: "ask-matt", path: userPath, scope: "user" })
    expect(skills[1]).toMatchObject({ name: "fallback-name", scope: "user" })
    expect(skills[2]).toMatchObject({
      name: "router",
      text: "$router",
      displayName: "ask-matt",
      description: "Choose the right Matt Pocock workflow",
      path,
      scope: "project",
    })
  })

  it("uses the CLI's relative config directory and skips malformed or non-invocable entries", async () => {
    await skill(join(cwd, "config"), "valid", "---\r\nname: valid\r\n---\r\n")
    await skill(join(cwd, "config"), "broken", "---\nname: [\n---\n")
    await skill(join(cwd, "config"), "hidden", "---\nname: hidden\nuser-invocable: false\n---\n")
    await skill(join(cwd, "config"), "unclosed", "---\nname: unclosed\n")
    expect(
      (await discoverClaudeSkills({ cwd, env: { CLAUDE_CONFIG_DIR: "config" } })).map(
        (s) => s.name,
      ),
    ).toEqual(["valid"])
  })

  it("lists enabled namespaced plugin skills and dispatches the last Skill without altering handoff", async () => {
    const installed = join(config, "plugins", "cache", "skills")
    const pluginSkill = await skill(
      installed,
      "ask-matt",
      "---\nname: router\ndescription: Route work\n---\n",
    )
    const userSkill = await skill(config, "interview", "---\ndisable-model-invocation: yes\n---\n")
    await skill(config, "hidden", "Disabled in the user's settings")
    await mkdir(join(installed, ".claude-plugin"))
    await writeFile(
      join(installed, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "mattpocock-skills" }),
    )
    await writeFile(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "mattpocock-skills@store": [{ scope: "user", installPath: installed }] },
      }),
    )
    await writeFile(
      join(config, "settings.json"),
      '{ "enabledPlugins": { "mattpocock-skills@store": true, }, "skillOverrides": { "hidden": "off" } }',
    )
    const source = { cwd, env: { CLAUDE_CONFIG_DIR: config } }
    const name = "mattpocock-skills:ask-matt"
    const skills = await discoverClaudeSkills(source)
    expect(skills.map(({ name }) => name)).toEqual(["interview", name])
    expect(skills[1]).toMatchObject({
      name,
      path: pluginSkill,
      pluginId: "mattpocock-skills@store",
    })
    const handoff = "Earlier text: $interview and $" + name
    const text = "Start with $interview then $" + name + " for the next change"
    const prompt = claudePrompt({ text, handoff }, source)
    if (typeof prompt === "string") throw new Error("Expected Claude SDK input blocks")
    const message = await prompt[Symbol.asyncIterator]().next()
    expect(message.value?.message.content).toEqual([
      {
        type: "text",
        text:
          handoff +
          "\n\nStart with /interview [Apply the Skill the user selected from " +
          userSkill +
          ".] then /" +
          name +
          " for the next change",
      },
      { type: "text", text: "/" + name + " for the next change" },
    ])
    const literal = claudePrompt({ text: "Keep $HOME and $hidden literal", handoff }, source)
    if (typeof literal === "string") throw new Error("Expected a streamed Claude SDK message")
    const unchanged = await literal[Symbol.asyncIterator]().next()
    expect(unchanged.value?.message.content).toBe(handoff + "\n\nKeep $HOME and $hidden literal")
    expect(claudePrompt({ text: "/compact $" + name }, source)).toBe("/compact $" + name)
  })

  it.each(["missing", "timeout"])("keeps local skills when the CLI is %s", async (failure) => {
    await skill(config, "ask-matt", "---\nname: ask-matt\n---\n")
    const close = vi.fn()
    const queryFn = vi.fn(
      () => ({ supportedCommands: () => new Promise(() => {}), close }) as unknown as Query,
    )
    const result = await listClaudeCommands({
      queryFn,
      executable: undefined,
      cwd,
      env: { CLAUDE_CONFIG_DIR: config },
      timeoutMs: 10,
      detect: async () => ({ installed: failure !== "missing", loggedIn: false }),
    })
    expect(result.map((s) => s.text)).toEqual(["$ask-matt"])
    if (failure === "missing") expect(queryFn).not.toHaveBeenCalled()
    else expect(close).toHaveBeenCalledOnce()
  })
})

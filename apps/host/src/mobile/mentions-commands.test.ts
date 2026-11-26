import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileMentionFrameBytes,
  mobileMentionMethods,
  type MobileAgentCommandsResult,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { projectMobileAgentCommand } from "./mentions"
import { createCommandDriver, setupMentionsHarness } from "./mentions.test-helpers"
import { mobileFrames } from "./mobile-frames"

describe("mobile composer.mentions agent.commands", () => {
  it("supports agent.commands with / vs $ distinction, refresh, scope checks, instance guards, and byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-commands-"))
    const removedRoot = await mkdtemp(join(tmpdir(), "pigcode-mobile-mentions-commands-removed-"))
    let revision = 1
    const receivedCwds: Array<string | null> = []
    const customDriver = createCommandDriver("cmd-agent", async (cwd) => {
      receivedCwds.push(cwd)
      return [
        {
          name: "compact",
          text: "/compact",
          description: "Compact conversation history",
          argumentHint: "[focus]",
          kind: "builtin",
        },
        {
          name: "deploy",
          text: "/deploy",
          description: `Custom command rev ${revision}`,
          argumentHint: "<env>",
          kind: "skill",
        },
        {
          name: "project-lint",
          text: "$project-lint",
          displayName: "Project Lint",
          description: "Run repository lint checks",
          shortDescription: "Lint repo",
          path: "/Users/private/repo/.claude/skills/project-lint/SKILL.md",
          scope: "project",
          kind: "skill",
        },
        {
          name: "user-notes",
          text: "$user-notes",
          displayName: "Notes",
          description: "Personal workflow notes",
          path: "/Users/private/.claude/skills/user-notes/SKILL.md",
          scope: "user",
          kind: "skill",
        },
        {
          name: "mattpocock-skills:tdd",
          text: "$mattpocock-skills:tdd",
          displayName: "TDD",
          description: "Long ".repeat(200),
          shortDescription: "Red-green-refactor",
          path: "/Users/private/.claude/plugins/matt/SKILL.md",
          scope: "user",
          pluginId: "mattpocock-skills@fixture",
          kind: "skill",
        },
      ]
    })

    const hugeDriver = createCommandDriver("huge-cmd", async () =>
      Array.from({ length: 150 }, (_, index) => ({
        name: `skill-${index}`,
        text: `$skill-${index}`,
        displayName: `Skill ${index}`,
        description: "D".repeat(450),
        shortDescription: "S".repeat(120),
        scope: "project",
        kind: "skill" as const,
      })),
    )

    const harness = await setupMentionsHarness({
      features: ["composer.mentions"],
      extraDrivers: [customDriver, hugeDriver],
    })
    try {
      const project = harness.ctx.projects.add(root, "命令项目")
      const removedProject = harness.ctx.projects.add(removedRoot, "已移除项目")
      const thread = harness.ctx.threads.create(project.id, "命令会话", "cmd-agent")
      const subagent = harness.ctx.threads.create(project.id, "子代理", "cmd-agent", thread.id)
      const hiddenThread = harness.ctx.threads.create(removedProject.id, "隐藏会话", "cmd-agent")
      harness.ctx.projects.remove(removedProject.id)

      const disabledInstance = harness.ctx.agents.createInstance("cmd-agent", "停用实例")
      harness.ctx.agents.updateInstance(disabledInstance.instanceId, { enabled: false })

      // Project scope query returns both `/` commands and `$` skills without leaking host path/pluginId.
      const first = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
      })
      const firstResult = first.result as MobileAgentCommandsResult
      expect(firstResult.truncated).toBe(false)
      expect(receivedCwds).toEqual([project.rootPath])
      expect(firstResult.commands).toEqual([
        {
          name: "compact",
          text: "/compact",
          kind: "command",
          description: "Compact conversation history",
          argumentHint: "[focus]",
          source: "builtin",
        },
        {
          name: "deploy",
          text: "/deploy",
          kind: "command",
          description: "Custom command rev 1",
          argumentHint: "<env>",
          source: "custom",
        },
        {
          name: "project-lint",
          text: "$project-lint",
          kind: "skill",
          displayName: "Project Lint",
          description: "Run repository lint checks",
          shortDescription: "Lint repo",
          source: "project",
        },
        {
          name: "user-notes",
          text: "$user-notes",
          kind: "skill",
          displayName: "Notes",
          description: "Personal workflow notes",
          source: "user",
        },
        {
          name: "mattpocock-skills:tdd",
          text: "$mattpocock-skills:tdd",
          kind: "skill",
          displayName: "TDD",
          description: expect.stringMatching(/…$/),
          shortDescription: "Red-green-refactor",
          source: "plugin",
        },
      ])
      expect(firstResult.commands[4]?.description?.length).toBeLessThanOrEqual(512)
      for (const command of firstResult.commands) {
        expect(command).not.toHaveProperty("path")
        expect(command).not.toHaveProperty("pluginId")
      }

      // Cached without refresh; refresh: true reloads updated catalog.
      revision = 2
      const cached = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
      })
      expect((cached.result as MobileAgentCommandsResult).commands[1]?.description).toBe(
        "Custom command rev 1",
      )
      const refreshed = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        projectId: project.id,
        refresh: true,
      })
      expect((refreshed.result as MobileAgentCommandsResult).commands[1]?.description).toBe(
        "Custom command rev 2",
      )

      // Thread scope and unscoped (user/builtin only -> cwd = null).
      await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
        threadId: thread.id,
      })
      await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "cmd-agent",
      })
      expect(receivedCwds).toEqual([project.rootPath, project.rootPath, null])

      // Reject conflicting scope or bad params.
      expect(
        await harness.mobileCall(mobileMentionMethods.agentCommands, {
          instanceId: "cmd-agent",
          threadId: thread.id,
          projectId: project.id,
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })

      // Reject nonexistent / disabled instances.
      for (const badInstanceId of ["no-such-instance", disabledInstance.instanceId]) {
        expect(
          await harness.mobileCall(mobileMentionMethods.agentCommands, {
            instanceId: badInstanceId,
          }),
        ).toMatchObject({ error: { code: "DRAFT_SELECTION_UNAVAILABLE" } })
      }

      // Reject invalid / unauthorized project or thread scope.
      for (const badScope of [
        { projectId: "pr_missing" },
        { projectId: removedProject.id },
        { threadId: "th_missing" },
        { threadId: subagent.id },
        { threadId: hiddenThread.id },
      ]) {
        expect(
          await harness.mobileCall(mobileMentionMethods.agentCommands, {
            instanceId: "cmd-agent",
            ...badScope,
          }),
        ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      }

      // Huge catalog is truncated safely within single-frame byte budget.
      const huge = await harness.mobileCall(mobileMentionMethods.agentCommands, {
        instanceId: "huge-cmd",
      })
      const hugeResult = huge.result as MobileAgentCommandsResult
      expect(hugeResult.truncated).toBe(true)
      expect(hugeResult.commands.length).toBeGreaterThan(0)
      expect(hugeResult.commands.length).toBeLessThan(150)
      expect(Buffer.byteLength(JSON.stringify(hugeResult))).toBeLessThanOrEqual(
        mobileMentionFrameBytes,
      )
      expect([...mobileFrames({ jsonrpc: "2.0", id: huge.id, result: hugeResult })]).toHaveLength(1)

      // Projection helper handles surrogate-pair clipping safely and skips unprefixed entries.
      expect(projectMobileAgentCommand({ name: "bad", text: "bad", kind: "builtin" })).toBeNull()
      const emojiDesc = "🚀".repeat(300)
      const clipped = projectMobileAgentCommand({
        name: "emoji",
        text: "$emoji",
        description: emojiDesc,
        scope: "system",
        kind: "skill",
      })
      expect(clipped?.source).toBe("system")
      expect(clipped?.description?.length).toBeLessThanOrEqual(512)
      expect(clipped?.description?.endsWith("…")).toBe(true)
    } finally {
      await harness.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
      await rm(removedRoot, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

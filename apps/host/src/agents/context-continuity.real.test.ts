/**
 * 真实 CLI 的上下文连续性：Host 重启后，agent 还记得重启前聊过的内容（#74）。
 * PIGCODE_REAL_CLAUDE=1 / PIGCODE_REAL_CODEX=1 时才跑，会消耗少量额度。
 */
import type { ThreadEvent } from "@pigcode/contracts"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"
import { Context } from "cordis"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { AgentDriver } from "./driver"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as agentsPlugin } from "./registry"

interface RealAgent {
  id: "claude" | "codex"
  enabled: boolean
  model: string | null
  create: () => AgentDriver & { close?: () => unknown }
}

const agents: RealAgent[] = [
  {
    id: "claude",
    enabled: process.env.PIGCODE_REAL_CLAUDE === "1",
    model: process.env.PIGCODE_CLAUDE_MODEL ?? null,
    create: () => new ClaudeDriver(),
  },
  {
    id: "codex",
    enabled: process.env.PIGCODE_REAL_CODEX === "1",
    model: process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol",
    create: () => new CodexDriver(),
  },
]

function lastAssistantText(events: ThreadEvent[]): string {
  const texts = events
    .filter((event) => event.type === "message.completed")
    .map((event) => event.payload as { role?: unknown; text?: unknown })
    .filter((payload) => payload.role === "assistant" && typeof payload.text === "string")
    .map((payload) => payload.text as string)
  return texts.at(-1) ?? ""
}

/** 用同一个数据库文件起一个 Host；第二次起就相当于应用重启。 */
async function startHost(dbPath: string, agent: RealAgent) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: dbPath })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin)
  const driver = agent.create()
  ctx.agents.register(driver)
  return {
    ctx,
    async stop() {
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
      await driver.close?.()
    },
  }
}

for (const agent of agents) {
  it.skipIf(!agent.enabled)(
    `${agent.id} remembers the conversation after a Host restart`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), `pigcode-continuity-${agent.id}-`))
      const root = join(dir, "project")
      mkdirSync(root)
      const dbPath = join(dir, "pigcode.db")

      const first = await startHost(dbPath, agent)
      const project = first.ctx.projects.add(root)
      const thread = first.ctx.threads.create(project.id, "continuity", agent.id)
      first.ctx.threads.updateSelection(thread.id, agent.id, agent.model)
      try {
        const run = await first.ctx.agents.startRun(
          thread.id,
          "Remember this code word: PELICAN-42. Reply with exactly OK.",
        )
        await run.done
        expect(first.ctx.agents.getRunStatus(run.runId)).toBe("completed")
      } finally {
        await first.stop()
      }

      const second = await startHost(dbPath, agent)
      try {
        const run = await second.ctx.agents.startRun(
          thread.id,
          "What was the code word? Reply with only the code word.",
        )
        await run.done
        expect(second.ctx.agents.getRunStatus(run.runId)).toBe("completed")
        const events = second.ctx.sessions.read(thread.id, 0)
        expect(lastAssistantText(events)).toContain("PELICAN-42")
        // 接回的是原来的原生会话，不是开了新会话再靠交接补上。
        expect(
          events.some(
            (event) =>
              event.type === "notice" &&
              (event.payload as { key?: string }).key === "session.resumeFailed",
          ),
        ).toBe(false)
        expect(second.ctx.agents.listSessions(thread.id)).toHaveLength(1)
      } finally {
        await second.stop()
      }
    },
    240_000,
  )
}

/** 真实 Codex 多会话：两个线程并行运行，分别得到 OK-1 与 OK-2。 */
import type { ThreadEvent } from "@pigcode/contracts"
import { Context } from "cordis"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as agentsPlugin } from "./registry"

/** 真实调用会消耗额度，默认跳过；只有显式设置环境变量才执行。 */
const enabled = process.env.PIGCODE_REAL_CODEX === "1"

/** 与用户确认的 6.1sol 对应；app-server 的模型目录里 id 为 gpt-6.1-sol。 */
const model = process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol"

/** 读取某线程的 assistant 文本；用户消息也使用 message.completed，需要按 role 过滤。 */
function assistantTexts(events: ThreadEvent[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== "message.completed") continue
    const payload = event.payload as { role?: unknown; text?: unknown } | null
    if (payload?.role === "assistant" && typeof payload.text === "string") texts.push(payload.text)
  }
  return texts
}

it.skipIf(!enabled)(
  "runs two codex threads in parallel with the real app-server",
  async () => {
    // app-server 以项目根目录作为 cwd，目录必须存在才能启动。
    const root = join(tmpdir(), "pigcode-m5-real-codex")
    mkdirSync(root, { recursive: true })
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agentsPlugin)
    const project = ctx.projects.add(root)
    const first = ctx.threads.create(project.id, "Codex A", "codex")
    const second = ctx.threads.create(project.id, "Codex B", "codex")
    // 线程选择里的 model 会传给 CodexDriver；env 只是 createThreadParams 的兜底。
    ctx.threads.updateSelection(first.id, "codex", model)
    ctx.threads.updateSelection(second.id, "codex", model)

    const startedAt = Date.now()
    try {
      const [a, b] = await Promise.all([
        ctx.agents.startRun(first.id, "Reply with exactly OK-1"),
        ctx.agents.startRun(second.id, "Reply with exactly OK-2"),
      ])
      await Promise.all([a.done, b.done])
      // 记录本次真实调用的模型与耗时，方便在验收记录里引用。
      console.info(`[real-codex-multi] model=${model} elapsedMs=${Date.now() - startedAt}`)

      expect(ctx.agents.getRunStatus(a.runId)).toBe("completed")
      expect(ctx.agents.getRunStatus(b.runId)).toBe("completed")
      const firstTexts = assistantTexts(ctx.sessions.read(first.id, 0))
      const secondTexts = assistantTexts(ctx.sessions.read(second.id, 0))
      expect(firstTexts.join("\n"), JSON.stringify(firstTexts)).toContain("OK-1")
      expect(secondTexts.join("\n"), JSON.stringify(secondTexts)).toContain("OK-2")
    } finally {
      // 先中断可能仍在运行的 turn，再切换到 fake 以 dispose 两个 app-server 子进程。
      ctx.agents.cancelAll()
      await ctx.agents.switchAgent(first.id, "fake", null).catch(() => undefined)
      await ctx.agents.switchAgent(second.id, "fake", null).catch(() => undefined)
      await ctx.fiber.dispose()
    }
  },
  180_000,
)

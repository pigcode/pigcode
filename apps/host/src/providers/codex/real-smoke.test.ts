/** 真实 Codex 冒烟：仅在 PIGCODE_REAL_CODEX=1 时启动真实 app-server。 */
import type { ProviderEvent } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { CodexDriver } from "./driver"

/** 真实调用会消耗额度，默认跳过；只有显式设置环境变量才执行。 */
const enabled = process.env.PIGCODE_REAL_CODEX === "1"

it.skipIf(!enabled)(
  "returns OK and usage from the real Codex app-server",
  async () => {
    const events: ProviderEvent[] = []
    const driver = new CodexDriver()
    const session = await driver.createSession({
      threadId: "real-smoke",
      cwd: process.cwd(),
      permissionMode: "workspace-write",
    })
    try {
      await driver.send(
        session,
        { text: "Reply with exactly OK" },
        {
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          // 该 prompt 不应触发工具调用，这里只做兜底。
          requestApproval: async () => "deny",
        },
      )
    } finally {
      await driver.dispose(session)
    }

    const completed = events.find((event) => event.type === "message.completed")
    expect(completed, JSON.stringify(events)).toBeDefined()
    if (completed?.type === "message.completed") {
      expect(completed.text).toContain("OK")
    }
    expect(events.some((event) => event.type === "usage.updated")).toBe(true)
    expect(events.some((event) => event.type === "run.failed")).toBe(false)
  },
  120_000,
)

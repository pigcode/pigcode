/** 真实 Claude 冒烟：仅在 PIGCODE_REAL_CLAUDE=1 时调用真实 SDK。 */
import type { AgentEvent } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { ClaudeDriver } from "./driver"

/** 真实调用会消耗额度，默认跳过；只有显式设置环境变量才执行。 */
const enabled = process.env.PIGCODE_REAL_CLAUDE === "1"

it.skipIf(!enabled)(
  "returns OK and usage from the real Claude CLI",
  async () => {
    const events: AgentEvent[] = []
    const driver = new ClaudeDriver()
    const session = await driver.createSession({
      threadId: "real-smoke",
      cwd: process.cwd(),
      permissionMode: "dontAsk",
    })
    try {
      await driver.send(
        session,
        { text: "Reply with exactly OK" },
        {
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          // dontAsk 下工具调用会被 SDK 直接拒绝，这里只做兜底。
          requestApproval: async () => "deny",
        },
      )
    } finally {
      await driver.dispose(session)
    }

    const completed = events.find((event) => event.type === "message.completed")
    expect(completed?.type).toBe("message.completed")
    if (completed?.type === "message.completed") {
      expect(completed.text).toContain("OK")
    }
    expect(events.some((event) => event.type === "usage.updated")).toBe(true)
    expect(events.some((event) => event.type === "run.failed")).toBe(false)
  },
  120_000,
)

it.skipIf(!enabled)(
  "reports a missing native session in a way the Host recognises",
  async () => {
    const events: AgentEvent[] = []
    const driver = new ClaudeDriver()
    // 这个 id 不对应任何会话文件：CLI 在发请求前就退出，不消耗额度。
    const session = await driver.createSession({
      threadId: "real-missing",
      cwd: process.cwd(),
      permissionMode: "dontAsk",
      nativeSessionId: "3f2b8c1e-0000-4000-8000-000000000000",
    })
    try {
      await driver.send(
        session,
        { text: "hi" },
        {
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          requestApproval: async () => "deny",
        },
      )
    } finally {
      await driver.dispose(session)
    }
    const failed = events.find((event) => event.type === "run.failed")
    expect(failed?.type).toBe("run.failed")
    if (failed?.type === "run.failed") expect(driver.isSessionNotFound(failed.message)).toBe(true)
  },
  60_000,
)

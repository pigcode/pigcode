/** 验证 Codex 的思考深度、模型目录中的档位，以及权限变化后不复用旧的 app-server。 */
import { describe, expect, it } from "vitest"
import type { ProviderRuntime } from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"
import { ScriptedTransport, messageOf, sentMessages } from "./scripted-transport"

/** 应答 turn/start 并立刻完成这一轮的 transport。 */
function completingTransport(): ScriptedTransport {
  return new ScriptedTransport({
    nativeThreadId: "th_native",
    onTurnStart: (message, replay) => {
      replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
      setTimeout(() => {
        replay.push({
          method: "turn/completed",
          params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
        })
      }, 0)
    },
  })
}

const runtime = (): ProviderRuntime => ({
  signal: new AbortController().signal,
  emit: () => undefined,
  requestApproval: async () => "allow-once",
})

describe("CodexDriver options", () => {
  it("sends the chosen reasoning effort with the turn and omits it otherwise", async () => {
    const transport = completingTransport()
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })

    await driver.send(session, { text: "think hard", effort: "xhigh" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).toMatchObject({ effort: "xhigh" })

    await driver.send(session, { text: "default" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).not.toHaveProperty("effort")
  })

  it("resumes the thread with new sandbox settings when the permission mode changes", async () => {
    const transports: ScriptedTransport[] = []
    const driver = new CodexDriver({
      transportFactory: () => {
        const transport = new ScriptedTransport({ nativeThreadId: "th_native" })
        transports.push(transport)
        return transport
      },
    })
    const first = await driver.createSession({ threadId: "t1", cwd: "/tmp", sessionId: "ps_1" })
    const same = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      sessionId: "ps_1",
      nativeSessionId: first.nativeSessionId,
    })
    expect(same.nativeSessionId).toBe("th_native")
    expect(transports).toHaveLength(1)

    const widened = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      sessionId: "ps_1",
      nativeSessionId: first.nativeSessionId,
      permissionMode: "danger-full-access",
    })
    expect(widened.permissionMode).toBe("danger-full-access")
    expect(transports).toHaveLength(2)
    expect(transports[0]?.closed).toBe(true)
    expect(messageOf(transports[1]!, "thread/resume")?.params).toMatchObject({
      threadId: "th_native",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })
    await driver.dispose(widened)
  })

  it("reads each model's reasoning efforts from model/list", async () => {
    const transport = new ScriptedTransport({
      nativeThreadId: "th_native",
      modelList: {
        data: [
          {
            id: "gpt-6.1-sol",
            displayName: "GPT-6.1 Sol",
            description: "Frontier coding model",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "medium", description: "balanced" },
              { reasoningEffort: "xhigh", description: "deepest" },
            ],
            defaultReasoningEffort: "medium",
          },
          {
            id: "gpt-6-mini",
            displayName: "GPT-6 Mini",
            supportedReasoningEfforts: ["minimal", "low"],
          },
        ],
      },
    })
    const driver = new CodexDriver({ transportFactory: () => transport })

    await expect(driver.listModels()).resolves.toEqual([
      {
        id: "gpt-6.1-sol",
        displayName: "GPT-6.1 Sol",
        description: "Frontier coding model",
        isDefault: true,
        efforts: ["low", "medium", "xhigh"],
        defaultEffort: "medium",
      },
      {
        id: "gpt-6-mini",
        displayName: "GPT-6 Mini",
        isDefault: false,
        efforts: ["minimal", "low"],
        defaultEffort: null,
      },
    ])
    expect(sentMessages(transport).some((message) => message.method === "model/list")).toBe(true)
  })
})

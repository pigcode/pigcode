/** 验证 Codex 的思考深度与快速模式、模型目录中的档位与服务档，以及权限变化后不复用旧的 app-server。 */
import { describe, expect, it } from "vitest"
import type { AgentRuntime } from "@pigcode/plugin-sdk"
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

const runtime = (): AgentRuntime => ({
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

    // Ultra 是 Codex 自己的档位，原样发给 app-server。
    await driver.send(session, { text: "think harder", effort: "ultra" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).toMatchObject({ effort: "ultra" })

    await driver.send(session, { text: "default" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).not.toHaveProperty("effort")
  })

  it("asks for the fast service tier and clears it once fast mode is turned off", async () => {
    const transport = completingTransport()
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })

    await driver.send(session, { text: "standard" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).not.toHaveProperty("serviceTier")

    await driver.send(session, { text: "quick", fast: true }, runtime())
    expect(messageOf(transport, "turn/start")?.params).toMatchObject({ serviceTier: "fast" })

    // 服务档会沿用到之后的轮次，切回标准要显式清掉。
    await driver.send(session, { text: "standard again" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).toMatchObject({ serviceTier: null })

    await driver.send(session, { text: "still standard" }, runtime())
    expect(messageOf(transport, "turn/start")?.params).not.toHaveProperty("serviceTier")
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
              { reasoningEffort: "ultra", description: "beyond max" },
            ],
            defaultReasoningEffort: "medium",
            serviceTiers: [{ id: "fast", name: "Fast", description: "Faster, costs more" }],
          },
          {
            id: "gpt-6-mini",
            displayName: "GPT-6 Mini",
            // none 是不思考，turbo 是界面还不认识的档位：都原样保留。
            supportedReasoningEfforts: ["none", "minimal", "low", "turbo"],
            serviceTiers: [],
          },
          {
            id: "gpt-6-legacy",
            displayName: "GPT-6 Legacy",
            additionalSpeedTiers: ["fast"],
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
        efforts: ["low", "medium", "xhigh", "ultra"],
        defaultEffort: "medium",
        fast: true,
      },
      {
        id: "gpt-6-mini",
        displayName: "GPT-6 Mini",
        isDefault: false,
        efforts: ["none", "minimal", "low", "turbo"],
        defaultEffort: null,
      },
      // 旧版 app-server 用 additionalSpeedTiers 列出服务档。
      { id: "gpt-6-legacy", displayName: "GPT-6 Legacy", isDefault: false, fast: true },
    ])
    expect(sentMessages(transport).some((message) => message.method === "model/list")).toBe(true)
  })
})

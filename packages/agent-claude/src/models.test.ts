/** 验证 Claude 模型目录：SDK 会话读取、未登录时的别名回退，以及 model/effort 传给 SDK。 */
import type { ModelInfo, Options, Query } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it, vi } from "vitest"
import { ClaudeDriver } from "./driver"
import { CLAUDE_FALLBACK_MODELS, listClaudeModels, parseClaudeModels } from "./models"
import { replayQuery } from "./replay"

const SDK_MODELS: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Use the default model",
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  { value: "haiku", displayName: "Haiku", description: "Fastest", supportsEffort: false },
]

/** 只实现 supportedModels/close 的 Query 替身。 */
function catalogQuery(models: Promise<ModelInfo[]>): {
  query: Query
  close: ReturnType<typeof vi.fn>
} {
  const close = vi.fn()
  return { query: { supportedModels: () => models, close } as unknown as Query, close }
}

describe("Claude model catalog", () => {
  it("maps SDK models to catalog entries with their effort levels", () => {
    expect(parseClaudeModels(SDK_MODELS)).toEqual([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Use the default model",
        isDefault: true,
        efforts: ["low", "medium", "high", "max"],
        defaultEffort: null,
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Fastest",
        isDefault: false,
        efforts: [],
        defaultEffort: null,
      },
    ])
  })

  it("keeps the xhigh level Claude Code 2.1 reports and leaves models without effort fields fixed", () => {
    const models: ModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "For complex work and everyday tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        description: "Fastest for quick answers",
      },
    ]
    expect(parseClaudeModels(models).map(({ id, efforts }) => ({ id, efforts }))).toEqual([
      { id: "opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-haiku-4-5-20251001", efforts: [] },
    ])
  })

  it("reads the catalog from an SDK session that never sends a prompt, then closes it", async () => {
    const fake = catalogQuery(Promise.resolve(SDK_MODELS))
    const queryFn = vi.fn(() => fake.query)
    const models = await listClaudeModels({
      queryFn,
      executable: "/usr/local/bin/claude",
      detect: async () => ({ installed: true, loggedIn: true }),
    })
    expect(models.map((entry) => entry.id)).toEqual(["default", "haiku"])
    expect(queryFn).toHaveBeenCalledTimes(1)
    const params = queryFn.mock.calls[0] as unknown as [{ prompt: unknown; options: Options }]
    expect(typeof params[0].prompt).not.toBe("string")
    expect(params[0].options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude")
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it("falls back to the CLI aliases without starting a session when not logged in", async () => {
    const queryFn = vi.fn()
    await expect(
      listClaudeModels({
        queryFn,
        executable: undefined,
        detect: async () => ({ installed: true, loggedIn: false }),
      }),
    ).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
    expect(queryFn).not.toHaveBeenCalled()
  })

  it("falls back when the SDK session does not answer in time", async () => {
    const fake = catalogQuery(new Promise<ModelInfo[]>(() => undefined))
    await expect(
      listClaudeModels({
        queryFn: () => fake.query,
        executable: undefined,
        detect: async () => ({ installed: true, loggedIn: true }),
        timeoutMs: 10,
      }),
    ).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it("passes the thread's model and the run's effort to the SDK", async () => {
    const captured: Options[] = []
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured.push(params.options)
        return replay(params)
      },
    })
    const runtime = {
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async () => "allow-once" as const,
    }

    const opus = await driver.createSession({ threadId: "t1", cwd: "/tmp", model: "opus" })
    await driver.send(opus, { text: "hello", effort: "max" }, runtime)
    expect(captured[0]).toMatchObject({ model: "opus", effort: "max" })

    // 「default」交给 CLI 自己选；minimal 档按 low 发送。
    const fallback = await driver.createSession({ threadId: "t2", cwd: "/tmp", model: "default" })
    await driver.send(fallback, { text: "hello", effort: "minimal" }, runtime)
    expect(captured[1]).not.toHaveProperty("model")
    expect(captured[1]).toMatchObject({ effort: "low" })

    await driver.send(fallback, { text: "hello" }, runtime)
    expect(captured[2]).not.toHaveProperty("effort")
  })
})

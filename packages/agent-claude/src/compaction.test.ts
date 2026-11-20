import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { AgentRuntime } from "@pigcode/plugin-sdk"
import { expect, it, vi } from "vitest"
import { ClaudeDriver } from "./driver"
import { replayQuery } from "./replay"

it("combines the configured compact window with other CLI settings and forwards native resume dialogs", async () => {
  const captured: Options[] = []
  const driver = new ClaudeDriver({
    queryFn: (params) => {
      captured.push(params.options)
      return replayQuery("fixtures/simple.jsonl")(params)
    },
  })
  const ask = vi
    .fn<NonNullable<AgentRuntime["askQuestions"]>>()
    .mockImplementation(async (request) => [request.questions[0]!.options[0]!.label])
  const runtime: AgentRuntime = {
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: async () => "deny",
    askQuestions: ask,
  }
  try {
    const send = async (idleCompaction: string, autoCompactWindow = "300000") => {
      const session = await driver.createSession({
        threadId: "t",
        cwd: "/tmp",
        nativeSessionId: "s",
        settings: { autoCompactWindow, idleCompaction },
      })
      await driver.send(session, { text: "continue", fast: true }, runtime)
      return captured.at(-1)!
    }
    const onReturn = await send("onReturn")
    expect(onReturn.settings).toMatchObject({
      fastMode: true,
      autoCompactWindow: 300000,
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" },
    })
    expect(onReturn.supportedDialogKinds).toContain("resume_return")
    const callback = { signal: new AbortController().signal, requestId: "q" }
    const dialogue = {
      dialogKind: "resume_return",
      payload: { sessionAgeMinutes: 45, estimatedTokens: 220000 },
    }
    expect(await onReturn.onUserDialog!(dialogue, callback)).toEqual({
      behavior: "completed",
      result: "compact",
    })
    expect(ask.mock.calls[0]?.[0].questions[0]?.question).toContain("220,000")
    const off = await send("off", "")
    expect(await off.onUserDialog!(dialogue, callback)).toEqual({
      behavior: "completed",
      result: "continue",
    })
    expect(
      await onReturn.onUserDialog!({ ...dialogue, payload: { estimatedTokens: 99999 } }, callback),
    ).toEqual({ behavior: "completed", result: "continue" })
    expect(ask).toHaveBeenCalledTimes(1)
    await expect(send("onReturn", "99999")).rejects.toThrow(/100000/)
  } finally {
    await driver.close()
  }
})

it("derives cache expiry from the matching main request and skips TTL guesses and child traffic", async () => {
  const { normalizeSdkMessage, createNormalizeState } = await import("./normalize")
  const state = createNormalizeState()
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-01T10:00:00Z"))
  try {
    const stream = (id: string, creation: unknown, parent: string | null = null) =>
      normalizeSdkMessage(
        {
          type: "stream_event",
          parent_tool_use_id: parent,
          event: { type: "message_start", message: { id, usage: { cache_creation: creation } } },
        } as never,
        state,
      )
    const assistant = (id: string, creation?: unknown) =>
      normalizeSdkMessage(
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id,
            model: "claude",
            content: [],
            usage: {
              input_tokens: 210000,
              output_tokens: 25,
              ...(creation ? { cache_creation: creation } : {}),
            },
          },
        } as never,
        state,
      )
    const result = () =>
      normalizeSdkMessage(
        {
          type: "result",
          subtype: "success",
          result: "",
          modelUsage: {},
          is_error: false,
        } as never,
        state,
      ).find((e) => e.type === "context.updated")
    stream("request", { ephemeral_5m_input_tokens: 100 })
    now.mockReturnValue(Date.parse("2026-05-01T10:01:30Z"))
    stream("child", { ephemeral_1h_input_tokens: 888 }, "tool1")
    assistant("request")
    expect(result()).toMatchObject({
      usedTokens: 210025,
      promptCacheExpiresAt: "2026-05-01T10:05:00.000Z",
    })
    stream("new", {})
    expect(result()).not.toHaveProperty("promptCacheExpiresAt")
    assistant("new")
    expect(result()).not.toHaveProperty("promptCacheExpiresAt")
    assistant("orphan", { ephemeral_1h_input_tokens: 100 })
    expect(result()).not.toHaveProperty("promptCacheExpiresAt")
  } finally {
    now.mockRestore()
  }
})

/** 一轮结束时主 agent 的上下文占用（#76）。 */
import { describe, expect, it } from "vitest"
import { createNormalizeState, normalizeSdkMessage, type NormalizeState } from "./normalize"

describe("context occupancy", () => {
  it("reports the main agent's context occupancy when the turn ends", () => {
    const state = createNormalizeState()
    // 子 agent 的请求在它自己的上下文里，不算主 agent 的占用。
    normalizeSdkMessage(
      {
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: { model: "claude-haiku-5-5", content: [], usage: { input_tokens: 900000 } },
      } as never,
      state,
    )
    normalizeSdkMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-5-5",
          content: [],
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 24753,
            cache_read_input_tokens: 22221,
            output_tokens: 4,
          },
        },
      } as never,
      state,
    )
    const result = (limit?: NormalizeState["contextLimit"]) => {
      const run = { ...state, ...(limit ? { contextLimit: limit } : {}) }
      return normalizeSdkMessage(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "OK",
          modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } },
          total_cost_usd: 0,
        } as never,
        run,
      ).find((event) => event.type === "context.updated")
    }
    expect(result()).toEqual({
      type: "context.updated",
      usedTokens: 46980,
      maxTokens: 1000000,
      autoCompactTokens: null,
    })
    expect(result({ maxTokens: 1000000, autoCompactTokens: 967000 })).toMatchObject({
      autoCompactTokens: 967000,
    })
  })
})

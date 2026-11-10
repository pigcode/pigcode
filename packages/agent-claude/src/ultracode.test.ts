/**
 * 验证 Ultracode 的可用性：开发者用 gen:ultracode 问 CLI 生成表，运行时只查表。
 * 这里测问 CLI 的那一步（只问表里没有的模型）和读目录时不再开会话去问。
 */
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it, vi } from "vitest"
import { listClaudeModels } from "./models"
import { askUltracode, realModelId } from "./ultracode"
import { ULTRACODE_MODELS } from "./ultracode-models"

const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" },
  { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "" },
] as ModelInfo[]

/** 真实 CLI 的回答：get_settings 的 applied.ultracodeAvailable 跟着 setModel 选的模型变。 */
const AVAILABLE: Record<string, boolean> = {
  default: true,
  haiku: true,
  "claude-opus-5-5": true,
  "claude-opus-4-6": false,
  "claude-sonnet-4-6": false,
}

function settingsQuery(options: { getSettings?: boolean } = {}) {
  let current = "default"
  const asked: string[] = []
  const query = {
    supportedModels: async () => MODELS,
    setModel: async (model: string) => {
      current = model
    },
    ...(options.getSettings === false
      ? {}
      : {
          getSettings: async () => {
            asked.push(current)
            return { applied: { model: current, ultracodeAvailable: AVAILABLE[current] } }
          },
        }),
    close: vi.fn(),
  }
  return { query: query as unknown as Query, asked }
}

describe("Ultracode availability", () => {
  it("asks only the models the table does not know, once per real model", async () => {
    const fake = settingsQuery()
    const table = new Map([["claude-haiku-5-5", true]])
    expect(await askUltracode(fake.query, MODELS, table)).toBe(true)
    // haiku 已经在表里；claude-opus-5-5 和 default 是同一个模型，只问一次。
    expect(fake.asked).toEqual(["default", "claude-opus-4-6", "claude-sonnet-4-6"])
    expect(Object.fromEntries(table)).toEqual({
      "claude-haiku-5-5": true,
      "claude-opus-5-5": true,
      "claude-opus-4-6": false,
      "claude-sonnet-4-6": false,
    })
  })

  it("reports a CLI that cannot answer get_settings", async () => {
    const fake = settingsQuery({ getSettings: false })
    expect(await askUltracode(fake.query, MODELS, new Map())).toBe(false)
  })

  it("files long-context variants under the same model", () => {
    expect(realModelId({ value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" })).toBe(
      "claude-opus-5-5",
    )
    expect(realModelId({ value: "claude-sonnet-5" })).toBe("claude-sonnet-5")
  })

  it("reads the catalog from the generated table without asking the CLI", async () => {
    const fake = settingsQuery()
    const models = await listClaudeModels({
      queryFn: () => fake.query,
      executable: undefined,
      detect: async () => ({ installed: true, loggedIn: true }),
    })
    expect(fake.asked).toEqual([])
    const marked = models.filter((model) => model.ultracode).map((model) => model.id)
    expect(marked).toEqual(
      MODELS.filter((model) => ULTRACODE_MODELS[realModelId(model)] === true).map(
        (model) => model.value,
      ),
    )
  })
})

/** 验证 Ultracode 的可用性：读目录时问 CLI，不写死名单；预算内问不完的在后台问完再关会话。 */
import type { ModelInfo, Options, Query } from "@anthropic-ai/claude-agent-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { listClaudeModels } from "./models"
import { resetUltracodeAnswers } from "./ultracode"

afterEach(() => resetUltracodeAnswers())

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

/** 模型目录会话的替身；slowMs 让具体型号的 setModel 变慢，像 CLI 校验模型那样。 */
function settingsQuery(options: { slowMs?: number; getSettings?: boolean } = {}) {
  let current = "default"
  const asked: string[] = []
  const close = vi.fn()
  const query = {
    supportedModels: async () => MODELS,
    setModel: async (model: string) => {
      if (model.startsWith("claude-") && options.slowMs) {
        await new Promise((resolve) => setTimeout(resolve, options.slowMs))
      }
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
    close,
  }
  return { query: query as unknown as Query, close, asked }
}

const ULTRACODE = (models: { id: string; ultracode?: boolean | undefined }[]) =>
  models.filter((model) => model.ultracode).map((model) => model.id)

describe("Ultracode availability", () => {
  it("asks the CLI for every model and opens Workflows on the catalog session", async () => {
    const fake = settingsQuery()
    const queryFn = vi.fn(() => fake.query)
    const models = await listClaudeModels({
      queryFn,
      executable: undefined,
      detect: async () => ({ installed: true, loggedIn: true }),
    })
    expect(ULTRACODE(models)).toEqual(["default", "haiku", "claude-opus-5-5"])
    // claude-opus-5-5 和 default 是同一个模型，只问一次。
    expect(fake.asked).toEqual(["default", "haiku", "claude-opus-4-6", "claude-sonnet-4-6"])
    const params = queryFn.mock.calls[0] as unknown as [{ options: Options }]
    expect(params[0].options.settings).toEqual({ enableWorkflows: true })
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it("answers within the budget, finishes the slow models in the background and remembers them", async () => {
    const first = settingsQuery({ slowMs: 40 })
    const source = {
      queryFn: () => first.query,
      executable: "/opt/claude",
      detect: async () => ({ installed: true, loggedIn: true }),
      ultracodeBudgetMs: 10,
    }
    const quick = await listClaudeModels(source)
    // 别名在预算里问完了；具体型号还没问到，先不标，会话也还开着。
    expect(ULTRACODE(quick)).toEqual(["default", "haiku", "claude-opus-5-5"])
    expect(first.close).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
    expect(first.asked).toContain("claude-sonnet-4-6")

    // 下一次读目录直接用记住的结果，不再一个个问。
    const second = settingsQuery()
    const again = await listClaudeModels({ ...source, queryFn: () => second.query })
    expect(ULTRACODE(again)).toEqual(["default", "haiku", "claude-opus-5-5"])
    expect(second.asked).toEqual([])
  })

  it("marks nothing when the CLI cannot answer get_settings", async () => {
    const fake = settingsQuery({ getSettings: false })
    const models = await listClaudeModels({
      queryFn: () => fake.query,
      executable: undefined,
      detect: async () => ({ installed: true, loggedIn: true }),
    })
    expect(models.map((model) => model.id)).toEqual(MODELS.map((model) => model.value))
    expect(ULTRACODE(models)).toEqual([])
    expect(fake.close).toHaveBeenCalledTimes(1)
  })
})

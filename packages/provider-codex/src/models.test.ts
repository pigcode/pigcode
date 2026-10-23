/** 验证 model/list 响应的宽容解析，不依赖真实 app-server。 */
import { describe, expect, it } from "vitest"
import { parseCodexModels } from "./models"

describe("parseCodexModels", () => {
  it("parses entries wrapped in data", () => {
    expect(
      parseCodexModels({
        data: [
          { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true },
          { id: "gpt-5", name: "GPT-5" },
        ],
      }),
    ).toEqual([
      { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true },
      { id: "gpt-5", displayName: "GPT-5", isDefault: false },
    ])
  })

  it("falls back to the model field and skips entries without id", () => {
    expect(
      parseCodexModels({
        models: [{ model: "o3", name: "o3" }, { displayName: "broken" }, "junk"],
      }),
    ).toEqual([{ id: "o3", displayName: "o3", isDefault: false }])
  })

  it("returns an empty list for unknown shapes", () => {
    expect(parseCodexModels(null)).toEqual([])
    expect(parseCodexModels({ data: "nope" })).toEqual([])
  })
})

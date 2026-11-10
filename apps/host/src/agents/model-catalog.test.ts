/** 验证模型目录的归一化与缓存：档位排序、默认档位校验、TTL 与并发去重。 */
import type { AgentModel } from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  applyModelPreferences,
  asReasoningEffort,
  createModelCatalogCache,
  normalizeModels,
  sortEfforts,
} from "./model-catalog"

const model = (id: string): AgentModel => ({
  id,
  displayName: id,
  isDefault: false,
  efforts: [],
  defaultEffort: null,
})

describe("reasoning efforts", () => {
  it("accepts the protocol levels and common spellings", () => {
    expect(asReasoningEffort("High")).toBe("high")
    expect(asReasoningEffort("x-high")).toBe("xhigh")
    expect(asReasoningEffort("extra_high")).toBe("xhigh")
    // none 是 Codex 的「不思考」档；认不得的档位原样保留，跟在它前一个已知档位后面。
    expect(asReasoningEffort("none")).toBe("none")
    expect(asReasoningEffort("Turbo")).toBe("Turbo")
    expect(asReasoningEffort("  ")).toBeNull()
    expect(asReasoningEffort(3)).toBeNull()
    expect(sortEfforts(["max", "low", "high", "low"])).toEqual(["low", "high", "max"])
    // Codex 按从低到高给出档位：认不得的 turbo 夹在 high 与 max 之间，排序后仍在那里。
    expect(sortEfforts(["max", "none", "high", "turbo", "low"])).toEqual([
      "none",
      "low",
      "high",
      "turbo",
      "max",
    ])
  })

  it("fills optional fields, drops duplicate ids and an out-of-range default", () => {
    expect(
      normalizeModels([
        {
          id: "a",
          displayName: "",
          isDefault: true,
          efforts: ["high", "low"],
          defaultEffort: "max",
        },
        { id: "a", displayName: "dup", isDefault: false },
        { id: "b", displayName: "B", isDefault: false, description: "fast", defaultEffort: "low" },
      ]),
    ).toEqual([
      { id: "a", displayName: "a", isDefault: true, efforts: ["low", "high"], defaultEffort: null },
      {
        id: "b",
        displayName: "B",
        description: "fast",
        isDefault: false,
        efforts: [],
        defaultEffort: null,
      },
    ])
  })
})

describe("model catalog cache", () => {
  it("reuses a catalog until it expires and shares concurrent loads", async () => {
    let now = 0
    const cache = createModelCatalogCache({ ttlMs: 1000, now: () => now })
    const load = vi.fn(async () => [model("m1")])

    const [first, second] = await Promise.all([cache.get("codex", load), cache.get("codex", load)])
    expect(first).toEqual([model("m1")])
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)

    now = 999
    await cache.get("codex", load)
    expect(load).toHaveBeenCalledTimes(1)

    now = 1000
    await cache.get("codex", load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not keep empty catalogs, and forgets an agent when invalidated", async () => {
    const cache = createModelCatalogCache()
    const empty = vi.fn(async (): Promise<AgentModel[]> => [])
    await cache.get("claude", empty)
    await cache.get("claude", empty)
    expect(empty).toHaveBeenCalledTimes(2)

    const load = vi.fn(async () => [model("m1")])
    await cache.get("fake", load)
    cache.invalidate("fake")
    await cache.get("fake", load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe("model preferences", () => {
  it("appends custom models, applies the saved order and flags hidden models", () => {
    const catalog = [model("a"), model("b"), model("c")]
    const result = applyModelPreferences(catalog, {
      custom: ["x", "b"],
      hidden: ["a"],
      order: ["c", "x"],
    })
    // 排过的在前（c、x），没排过的按原顺序跟在后面；目录里已有的 b 不当自定义模型重复添加。
    expect(result.map((item) => item.id)).toEqual(["c", "x", "a", "b"])
    expect(result.find((item) => item.id === "x")?.custom).toBe(true)
    expect(result.filter((item) => item.hidden).map((item) => item.id)).toEqual(["a"])
  })

  it("ignores order entries for models that are not in the catalog", () => {
    const result = applyModelPreferences([model("a"), model("b")], {
      custom: [],
      hidden: ["gone"],
      order: ["gone", "b"],
    })
    expect(result.map((item) => item.id)).toEqual(["b", "a"])
    expect(result.some((item) => item.hidden)).toBe(false)
  })
})

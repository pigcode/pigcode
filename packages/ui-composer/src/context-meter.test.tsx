import { describe, expect, it } from "vitest"
import { contextLevel, formatTokens } from "./context-meter"

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1500, "1.5k"],
    [9999, "10k"],
    [168000, "168k"],
    [999499, "999k"],
    [999500, "1m"],
    [1000000, "1m"],
    [1250000, "1.3m"],
  ])("%d → %s", (value, text) => {
    expect(formatTokens(value)).toBe(text)
  })
})

describe("contextLevel", () => {
  it("measures against the compaction line when there is one", () => {
    expect(
      contextLevel({ usedTokens: 87000, maxTokens: 200000, autoCompactTokens: 100000 }),
    ).toEqual({ ratio: 0.87, level: "high" })
  })

  it("warns near the limit and caps the ring at full", () => {
    expect(contextLevel({ usedTokens: 50, maxTokens: 100, autoCompactTokens: null })?.level).toBe(
      "ok",
    )
    expect(contextLevel({ usedTokens: 96, maxTokens: 100, autoCompactTokens: null })?.level).toBe(
      "full",
    )
    expect(contextLevel({ usedTokens: 300, maxTokens: 100, autoCompactTokens: null })?.ratio).toBe(
      1,
    )
  })

  it("has no ring without a limit", () => {
    expect(contextLevel({ usedTokens: 50, maxTokens: null, autoCompactTokens: null })).toBeNull()
  })
})

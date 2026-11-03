/** 验证前进后退历史的记录、分支与清理。 */
import { describe, expect, it } from "vitest"
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  currentLocation,
  goBack,
  goForward,
  pruneHistory,
  pushLocation,
  type NavLocation,
} from "./navigation"

const a: NavLocation = { kind: "thread", threadId: "a" }
const b: NavLocation = { kind: "thread", threadId: "b" }
const c: NavLocation = { kind: "thread", threadId: "c" }
const settings: NavLocation = { kind: "settings", page: "general" }

describe("navigation history", () => {
  it("records locations once and walks back and forward", () => {
    let history = pushLocation(EMPTY_HISTORY, a)
    history = pushLocation(history, a)
    history = pushLocation(history, b)
    history = pushLocation(history, settings)
    expect(history.entries).toEqual([a, b, settings])
    expect(canGoForward(history)).toBe(false)

    history = goBack(goBack(history))
    expect(currentLocation(history)).toEqual(a)
    expect(canGoBack(history)).toBe(false)
    expect(goBack(history)).toBe(history)

    history = goForward(history)
    expect(currentLocation(history)).toEqual(b)
    expect(canGoForward(history)).toBe(true)
  })

  it("drops the forward branch when navigating somewhere new", () => {
    let history = pushLocation(pushLocation(pushLocation(EMPTY_HISTORY, a), b), c)
    history = pushLocation(goBack(goBack(history)), settings)
    expect(history.entries).toEqual([a, settings])
    expect(canGoForward(history)).toBe(false)
  })

  it("treats different settings pages as different places", () => {
    const history = pushLocation(pushLocation(EMPTY_HISTORY, settings), {
      kind: "settings",
      page: "plugins",
    })
    expect(history.entries).toHaveLength(2)
  })

  it("prunes threads that no longer exist and merges neighbours that become equal", () => {
    let history = pushLocation(EMPTY_HISTORY, a)
    for (const location of [b, a, c]) history = pushLocation(history, location)
    history = goBack(history)
    const pruned = pruneHistory(history, (location) =>
      location.kind === "thread" ? location.threadId !== "b" : true,
    )
    expect(pruned.entries).toEqual([a, c])
    expect(currentLocation(pruned)).toEqual(a)
  })

  it("keeps at most 50 entries", () => {
    let history = EMPTY_HISTORY
    for (let index = 0; index < 60; index += 1) {
      history = pushLocation(history, { kind: "thread", threadId: String(index) })
    }
    expect(history.entries).toHaveLength(50)
    expect(currentLocation(history)).toEqual({ kind: "thread", threadId: "59" })
  })
})

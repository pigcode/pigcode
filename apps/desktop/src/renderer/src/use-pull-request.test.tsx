/** 验证 usePullRequest Hook：status 读取及 create(draft)/comment/merge/ready/close/reopen 全套写操作。 */
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Connection } from "@pigcode/client-runtime"
import type { PullRequestInfo } from "@pigcode/contracts"
import { describe, expect, it, vi } from "vitest"
import { usePullRequest } from "./use-pull-request"

const BASE_PR: PullRequestInfo = {
  number: 42,
  url: "https://github.com/pigcode/pigcode/pull/42",
  state: "OPEN",
  isDraft: true,
  title: "PR write actions",
  headRefName: "feat/pr-write",
  baseRefName: "main",
}

function fakeConnection(callImpl: (method: string, params: unknown) => Promise<unknown>): Connection {
  return {
    call: callImpl,
    onEvent: () => () => undefined,
  } as unknown as Connection
}

describe("usePullRequest", () => {
  it("loads status and invokes create, ready, comment, close, reopen, and merge", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const onCheckoutChanged = vi.fn()
    const connection = fakeConnection(async (method, params) => {
      calls.push({ method, params })
      switch (method) {
        case "pr.status":
          return null
        case "pr.create":
          return BASE_PR
        case "pr.ready":
          return { ...BASE_PR, isDraft: false }
        case "pr.comment":
          return { ok: true }
        case "pr.close":
          return { ...BASE_PR, isDraft: false, state: "CLOSED" }
        case "pr.reopen":
          return { ...BASE_PR, isDraft: false, state: "OPEN" }
        case "pr.merge":
          return { ...BASE_PR, isDraft: false, state: "MERGED" }
        default:
          throw new Error(`Unexpected ${method}`)
      }
    })

    const scope = { threadId: "th_1" }
    const { result } = renderHook(() =>
      usePullRequest(connection, scope, true, 0, onCheckoutChanged),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pullRequest).toBeNull()

    await act(async () => {
      await result.current.create({ title: "PR write actions", draft: true })
    })
    expect(result.current.pullRequest?.isDraft).toBe(true)

    await act(async () => {
      await result.current.ready()
    })
    expect(result.current.pullRequest?.isDraft).toBe(false)

    await act(async () => {
      await result.current.comment("Looks good")
    })

    await act(async () => {
      await result.current.close()
    })
    expect(result.current.pullRequest?.state).toBe("CLOSED")

    await act(async () => {
      await result.current.reopen()
    })
    expect(result.current.pullRequest?.state).toBe("OPEN")

    await act(async () => {
      await result.current.merge({ method: "squash", deleteBranch: true })
    })
    expect(result.current.pullRequest?.state).toBe("MERGED")
    expect(onCheckoutChanged).toHaveBeenCalledTimes(1)
    expect(calls.map((c) => c.method)).toEqual([
      "pr.status",
      "pr.create",
      "pr.ready",
      "pr.comment",
      "pr.close",
      "pr.reopen",
      "pr.merge",
    ])
  })
})

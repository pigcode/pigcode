/**
 * 一轮运行长时间收不到 Agent 事件时，Host 要提示用户（#83）：Codex 偶尔在 turn/start 之后
 * 不再发任何通知，界面会一直转圈。提示只出现一次，每收到一条事件就重新计时，
 * 等审批或等用户回答时不计时。
 */
import type { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRuntime, ApprovalDecision } from "./driver"
import { createExecute, type ExecuteDeps } from "./run-execute"
import type { ActiveRun } from "./run-queue"

/** 安装一个只记录事件的 run；send 由每个用例决定什么时候结束。 */
function harness(
  send: (runtime: AgentRuntime) => Promise<void>,
  requestApproval: (
    run: ActiveRun,
    request: { toolName: string },
  ) => Promise<ApprovalDecision> = async () => "allow-once",
) {
  const appended: Array<{ type: string; payload: unknown }> = []
  const run = {
    runId: "run_1",
    threadId: "th_1",
    session: {
      id: "session_1",
      threadId: "th_1",
      cwd: "/tmp",
      nativeSessionId: "native_1",
      permissionMode: "workspace-write",
      model: null,
    },
    driver: {
      id: "codex",
      send: (_session: unknown, _input: unknown, runtime: AgentRuntime) => send(runtime),
      dispose: async () => undefined,
    },
    controller: new AbortController(),
    emitLive: () => undefined,
    status: "running",
    done: Promise.resolve(),
    resolveDone: () => undefined,
    approvals: new Set<string>(),
    liveText: "",
  } as unknown as ActiveRun
  const deps: ExecuteDeps = {
    ctx: {} as Context,
    activeRuns: new Map([[run.runId, run]]),
    hooks: {
      isActive: () => true,
      append: (_threadId, _runId, type, payload) => appended.push({ type, payload }),
      updateNativeSessionId: () => undefined,
      finish: () => undefined,
    },
    requestApproval,
    askQuestions: async () => [],
  }
  return { run, appended, execute: createExecute(deps) }
}

/** 一直等到 run 被中断，模拟一个再也不发事件的 Agent。 */
function waitForAbort(runtime: AgentRuntime): Promise<void> {
  return new Promise((resolve) => {
    runtime.signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("execute stall notice", () => {
  it("warns once after two minutes without any agent event", async () => {
    vi.useFakeTimers()
    const { run, appended, execute } = harness(waitForAbort)
    const running = execute(run, { text: "hello" })
    await vi.advanceTimersByTimeAsync(119_000)
    expect(appended).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(appended).toEqual([
      {
        type: "notice",
        payload: { level: "warning", key: "run.stalled", params: { seconds: "120" } },
      },
    ])

    // 只提示一次：之后继续没有事件也不再重复。
    await vi.advanceTimersByTimeAsync(600_000)
    expect(appended).toHaveLength(1)

    run.controller.abort()
    await running
  })

  it("restarts the clock on every event", async () => {
    vi.useFakeTimers()
    const { run, appended, execute } = harness(async (runtime) => {
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      runtime.emit({ type: "message.delta", text: "still here" })
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      runtime.emit({ type: "message.delta", text: "still here" })
      await waitForAbort(runtime)
    })
    const running = execute(run, { text: "hello" })

    // 第一条事件在 60 秒，第二条在 120 秒；距离第二条不到两分钟时不该提示。
    await vi.advanceTimersByTimeAsync(239_000)
    expect(appended).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(appended.map((entry) => entry.type)).toEqual(["notice"])

    run.controller.abort()
    await running
  })

  it("does not count time spent waiting for an approval", async () => {
    vi.useFakeTimers()
    let decide: (decision: ApprovalDecision) => void = () => undefined
    const { run, appended, execute } = harness(
      async (runtime) => {
        await runtime.requestApproval({ toolName: "Bash", input: {} })
        await waitForAbort(runtime)
      },
      () => new Promise<ApprovalDecision>((resolve) => (decide = resolve)),
    )
    const running = execute(run, { text: "hello" })

    // 人迟迟不点审批，这不是 Agent 卡住。
    await vi.advanceTimersByTimeAsync(600_000)
    expect(appended).toEqual([])

    decide("allow-once")
    await vi.advanceTimersByTimeAsync(119_000)
    expect(appended).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(appended.map((entry) => entry.type)).toEqual(["notice"])

    run.controller.abort()
    await running
  })
})

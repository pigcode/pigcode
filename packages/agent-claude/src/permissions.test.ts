import { expect, it, vi } from "vitest"
import { ClaudeDriver } from "./driver"
import { replayQuery } from "./replay"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { claudeExecutionModes, claudePermissionMode, syncClaudePlanMode } from "./permissions"

it.each([
  ["approval-required", "default"],
  ["auto-accept-edits", "acceptEdits"],
  ["auto", "auto"],
  ["full-access", "bypassPermissions"],
])("maps unified mode %s to Claude", (mode, expected) => {
  expect(claudePermissionMode(mode, false)).toBe(expected)
  expect(claudePermissionMode(mode, true)).toBe("plan")
  expect(claudeExecutionModes.plan).toBe(true)
})

it("restores the chosen permission mode after leaving native plan mode", async () => {
  const captured: string[] = []
  const replay = replayQuery("fixtures/simple.jsonl")
  const driver = new ClaudeDriver({
    queryFn: (params) => {
      captured.push(params.options.permissionMode!)
      return replay(params)
    },
  })
  for (const planMode of [false, true, false]) {
    const session = await driver.createSession({
      threadId: "test",
      cwd: "/tmp",
      permissionMode: "auto-accept-edits",
      planMode,
    })
    await driver.send(
      session,
      { text: "Test modes" },
      { signal: new AbortController().signal, emit: () => {}, requestApproval: async () => "deny" },
    )
    await driver.dispose(session)
  }
  expect(captured).toEqual(["acceptEdits", "plan", "acceptEdits"])
})

it("restores edit approval after the user accepts a native plan", async () => {
  let options: Options | undefined
  const replay = replayQuery("fixtures/simple.jsonl")
  const driver = new ClaudeDriver({
    queryFn: (params) => {
      options = params.options
      return replay(params)
    },
  })
  const session = await driver.createSession({
    threadId: "plan",
    cwd: "/tmp",
    permissionMode: "auto-accept-edits",
    planMode: true,
  })
  const setPlanMode = vi.fn()
  const runtime = {
    signal: new AbortController().signal,
    emit: () => {},
    requestApproval: async () => "allow-once" as const,
    setPlanMode,
  }
  await driver.send(session, { text: "plan" }, runtime)
  const result = await options!.canUseTool!("ExitPlanMode", {}, {
    signal: runtime.signal,
    toolUseID: "exit",
  } as Parameters<NonNullable<Options["canUseTool"]>>[2])
  expect(result).toMatchObject({
    behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  })
  syncClaudePlanMode(
    {
      type: "tool.completed",
      toolCallId: "exit",
      name: "ExitPlanMode",
      output: "denied",
      isError: true,
    },
    session,
    runtime,
  )
  expect(setPlanMode).not.toHaveBeenCalled()
  syncClaudePlanMode(
    {
      type: "tool.completed",
      toolCallId: "exit",
      name: "ExitPlanMode",
      output: "approved",
      isError: false,
    },
    session,
    runtime,
  )
  expect(setPlanMode).toHaveBeenCalledWith(false)
  expect(session.planMode).toBe(false)
  await driver.dispose(session)
})

it("allows normal tools in full access and still asks while planning", async () => {
  let options: Options | undefined
  const replay = replayQuery("fixtures/simple.jsonl")
  const driver = new ClaudeDriver({
    queryFn: (params) => {
      options = params.options
      return replay(params)
    },
  })
  const requestApproval = vi.fn(async () => "deny" as const)
  const runtime = { signal: new AbortController().signal, emit: () => {}, requestApproval }
  const approvalOptions = { signal: runtime.signal, toolUseID: "cmd" } as Parameters<
    NonNullable<Options["canUseTool"]>
  >[2]
  const direct = await driver.createSession({
    threadId: "full",
    cwd: "/tmp",
    permissionMode: "full-access",
  })
  await driver.send(direct, { text: "execute" }, runtime)
  expect(options?.allowDangerouslySkipPermissions).toBe(true)
  await expect(
    options!.canUseTool!("Bash", { command: "echo ok" }, approvalOptions),
  ).resolves.toMatchObject({ behavior: "allow" })
  expect(requestApproval).not.toHaveBeenCalled()
  await driver.dispose(direct)
  const plan = await driver.createSession({
    threadId: "plan",
    cwd: "/tmp",
    permissionMode: "full-access",
    planMode: true,
  })
  await driver.send(plan, { text: "plan" }, runtime)
  await expect(
    options!.canUseTool!("Bash", { command: "echo ok" }, approvalOptions),
  ).resolves.toMatchObject({ behavior: "deny" })
  expect(requestApproval).toHaveBeenCalledTimes(1)
  await driver.dispose(plan)
})

import { expect, it, vi } from "vitest"
import { CodexDriver } from "./driver"
import { ScriptedTransport, messageOf, sentMessages } from "./scripted-transport"
import { codexExecutionModes, codexPermissionConfig } from "./permissions"
import type { AgentRuntime } from "@pigcode/plugin-sdk"

const runtime = (): AgentRuntime => ({
  signal: new AbortController().signal,
  emit: () => {},
  requestApproval: async () => "deny",
})
const transport = () =>
  new ScriptedTransport({
    nativeThreadId: "native",
    onTurnStart(message, replay) {
      replay.push({ id: message.id, result: { turn: { id: "turn" } } })
      setTimeout(
        () =>
          replay.push({
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "turn", status: "completed" } },
          }),
        0,
      )
    },
  })

it.each([
  ["approval-required", "untrusted", "read-only", "user"],
  ["auto-accept-edits", "on-request", "workspace-write", "user"],
  ["auto", "on-request", "workspace-write", "auto_review"],
  ["full-access", "never", "danger-full-access", "user"],
])(
  "maps unified mode %s to native Codex permissions",
  (mode, approvalPolicy, sandbox, approvalsReviewer) => {
    expect(codexPermissionConfig(mode)).toEqual({ approvalPolicy, sandbox, approvalsReviewer })
    expect(codexExecutionModes.plan).toBe(true)
  },
)

it("toggles native planning independently without changing the selected permissions or model", async () => {
  const replay = transport()
  const factory = vi.fn(() => replay)
  const driver = new CodexDriver({ transportFactory: factory })
  const base = {
    threadId: "test",
    cwd: "/tmp",
    model: "gpt-6.1-sol",
    permissionMode: "auto-accept-edits",
  }
  const plan = await driver.createSession({ ...base, planMode: true })
  await driver.send(plan, { text: "Plan this", effort: "high" }, runtime())
  expect(messageOf(replay, "initialize")?.params).toMatchObject({
    capabilities: { experimentalApi: true },
  })
  expect(messageOf(replay, "thread/start")?.params).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  })
  expect(messageOf(replay, "turn/start")?.params).toMatchObject({
    collaborationMode: {
      mode: "plan",
      settings: { model: "gpt-6.1-sol", reasoning_effort: "high", developer_instructions: null },
    },
  })
  const normal = await driver.createSession({
    ...base,
    nativeSessionId: plan.nativeSessionId,
    planMode: false,
  })
  await driver.send(normal, { text: "Implement this" }, runtime())
  expect(factory).toHaveBeenCalledTimes(1)
  expect(messageOf(replay, "turn/start")?.params).toMatchObject({
    collaborationMode: { mode: "default" },
  })
  await driver.dispose(normal)
})

it("clears auto-review when resuming a thread in manual approval mode", async () => {
  const replays: ScriptedTransport[] = []
  const driver = new CodexDriver({
    transportFactory: () => {
      const replay = transport()
      replays.push(replay)
      return replay
    },
  })
  const auto = await driver.createSession({ threadId: "test", cwd: "/tmp", permissionMode: "auto" })
  expect(messageOf(replays[0]!, "thread/start")?.params).toMatchObject({
    approvalsReviewer: "auto_review",
  })
  const manual = await driver.createSession({
    threadId: "test",
    cwd: "/tmp",
    nativeSessionId: auto.nativeSessionId,
    permissionMode: "approval-required",
  })
  expect(messageOf(replays[1]!, "thread/resume")?.params).toMatchObject({
    approvalsReviewer: "user",
    approvalPolicy: "untrusted",
  })
  expect(replays[0]!.closed).toBe(true)
  await driver.dispose(manual)
})

it("answers native plan questions using the original question ids", async () => {
  const replay = new ScriptedTransport({
    nativeThreadId: "native",
    onTurnStart(message, server) {
      server.push({ id: message.id, result: { turn: { id: "turn" } } })
      setTimeout(
        () =>
          server.push({
            id: "question-request",
            method: "item/tool/requestUserInput",
            params: {
              questions: [
                {
                  id: "scope",
                  question: "Which scope?",
                  header: "Scope",
                  options: [{ label: "Small", description: "Only this feature" }],
                },
              ],
            },
          }),
        0,
      )
    },
  })
  const driver = new CodexDriver({ transportFactory: () => replay })
  const session = await driver.createSession({
    threadId: "test",
    cwd: "/tmp",
    planMode: true,
    model: "gpt-6.1-sol",
  })
  const askQuestions = vi.fn(async () => ["Small"])
  const sending = driver.send(session, { text: "Plan this" }, { ...runtime(), askQuestions })
  await vi.waitFor(() =>
    expect(
      sentMessages(replay).find((message) => message.id === "question-request")?.result,
    ).toEqual({ answers: { scope: { answers: ["Small"] } } }),
  )
  expect(askQuestions).toHaveBeenCalledWith({
    questions: [
      {
        question: "Which scope?",
        header: "Scope",
        options: [{ label: "Small", description: "Only this feature" }],
        multiSelect: false,
      },
    ],
  })
  replay.push({
    method: "turn/completed",
    params: { threadId: "native", turn: { id: "turn", status: "completed" } },
  })
  await sending
  await driver.dispose(session)
})

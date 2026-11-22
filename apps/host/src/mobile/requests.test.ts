import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  mobileRequestAnswerBytes,
  mobilePairingViewSchema,
  mobileRequestTarget,
  rpcSuccessSchema,
  type MobileRequestDetails,
  type ThreadEvent,
} from "@pigcode/contracts"
import { expect, it } from "vitest"
import type { AgentDriver } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { MemoryTransport } from "../rpc/memory-transport"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { ThreadFeed } from "../rpc/thread-feed"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

it("returns the actual desktop approval and deduplicates a conflicting mobile submission", async () => {
  const wire = new MemoryTransport()
  const deviceKey = Buffer.alloc(32, 3).toString("base64url")
  const events: ThreadEvent[] = []
  let threadId = ""
  let mobile!: MobileSidebarRpc
  let failReceipt!: (failed: boolean) => void
  const host = await startMobileHost({
    prepare(ctx) {
      failReceipt = (failed) =>
        ctx.storage.db.exec(
          failed
            ? `CREATE TRIGGER fail_request_receipt BEFORE INSERT ON command_receipts
           BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END`
            : "DROP TRIGGER fail_request_receipt",
        )
      const project = ctx.projects.add("/tmp/pigcode-mobile-approval", "审批验收")
      threadId = ctx.threads.create(project.id, "当前会话", "fake").id
      const devices = new PairedDevices(ctx.settings)
      devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: 1 })
      mobile = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
        computerKey: Buffer.alloc(32, 1),
        computerName: "测试电脑",
        deviceKey,
        features: ["request.write"],
        relayRevision: () => undefined,
      })
      mobile.start()
    },
    onDesktopMessage(raw) {
      const message = raw as { method?: string; params: ThreadEvent }
      if (message.method === "thread.event") events.push(message.params)
    },
  })

  async function phoneCall(method: string, params: Record<string, unknown>) {
    const id = randomUUID()
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    const reply = await wire.client.next()
    expect(reply).toMatchObject({ id })
    return reply
  }

  try {
    await host.call("thread.subscribe", { threadId, cursor: 0 })
    const started = (await host.call("run.start", { threadId, text: "approve" })) as {
      result: { runId: string }
    }
    const { runId } = started.result
    const request = () => events.find((event) => event.type === "approval.requested")
    await expect.poll(request).toBeDefined()
    const { requestId } = request()!.payload as { requestId: string }
    const target = { threadId, runId, requestId }
    expect(await phoneCall("request.details", target)).toMatchObject({
      result: {
        ...target,
        approval: { toolName: "Bash", decisions: ["allow-once", "allow-for-session", "deny"] },
      },
    })
    const commandId = randomUUID()
    const rejectedChoice = { ...target, commandId, decision: "allow-for-session" }
    failReceipt(true)
    try {
      expect(await phoneCall("run.respondApproval", rejectedChoice)).toMatchObject({
        error: { code: "COMMAND_FAILED" },
      })
      expect(events.some((event) => event.type === "approval.resolved")).toBe(false)
      expect(await phoneCall("request.details", target)).toMatchObject({ result: target })
    } finally {
      failReceipt(false)
    }
    expect(await host.call("run.respondApproval", { ...target, decision: "deny" })).toMatchObject({
      result: { ok: true },
    })
    const actual = await phoneCall("run.respondApproval", rejectedChoice)
    const receipt = {
      method: "run.respondApproval",
      ...target,
      commandId,
      outcome: { state: "already-handled", decision: "deny" },
    }
    expect(actual).toMatchObject({ result: receipt })
    expect(await phoneCall("run.respondApproval", rejectedChoice)).toMatchObject({
      result: receipt,
    })
    expect(await phoneCall("command.receipt", { commandId })).toMatchObject({ result: { receipt } })
    expect(
      await phoneCall("run.respondApproval", { ...rejectedChoice, decision: "allow-once" }),
    ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })
    await expect
      .poll(() => events.filter((event) => event.type === "approval.resolved"))
      .toMatchObject([{ runId, payload: { requestId, decision: "deny" } }])
    await expect.poll(() => events.find((event) => event.type === "run.completed")).toBeDefined()
  } finally {
    mobile.stop()
    await host.stop()
  }
})

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "shows approval and questions over Go WSS, synchronizes decisions, and expires stopped requests",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-mobile-requests-"))
    const paths = { settingsPath: join(dir, "settings.json"), storagePath: join(dir, "host.db") }
    const events: ThreadEvent[] = []
    const driver: AgentDriver = {
      id: "mobile-request-fixture",
      displayName: "Mobile request fixture",
      features: new FakeAgentDriver().features,
      async createSession(input) {
        return {
          id: input.sessionId ?? "mobile-request-session",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: null,
          permissionMode: "workspace-write",
          model: null,
        }
      },
      async send(_session, _input, runtime) {
        const [decision, answers] = await Promise.all([
          runtime.requestApproval({
            toolName: "Bash",
            title: "可否运行验收命令？",
            input: { command: "echo approved" },
            decisions: ["allow-once", "deny"],
          }),
          runtime.askQuestions!({
            questions: [
              {
                question: "验证哪些平台？",
                multiSelect: true,
                allowCustomAnswer: false,
                options: [{ label: "iOS" }, { label: "Android" }],
              },
              { question: "还有什么补充？", multiSelect: false, options: [{ label: "模拟器" }] },
            ],
          }),
        ])
        if (runtime.signal.aborted) return
        runtime.emit({ type: "message.completed", text: [decision, ...answers].join(" / ") })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    let threadId = ""
    let host = await startMobileHost({
      ...paths,
      prepare(ctx) {
        ctx.agents.register(driver)
        const project = ctx.projects.add(dir, "多端请求")
        threadId = ctx.threads.create(project.id, "验收会话", driver.id).id
      },
      onDesktopMessage(raw) {
        const message = raw as { method?: string; params: ThreadEvent }
        if (message.method === "thread.event") events.push(message.params)
      },
    })
    const dart = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostic = ""
    dart.stderr.setEncoding("utf8").on("data", (data: string) => (diagnostic += data))
    dart.on("error", (error) => (diagnostic += error.message))
    const lines = createInterface({ input: dart.stdout })[Symbol.asyncIterator]()
    function send(action: string, params: Record<string, unknown> = {}) {
      dart.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...params }) + "\n")
    }
    async function receive() {
      const result = await lines.next()
      if (result.done) throw new Error(diagnostic || "Dart client exited early")
      return JSON.parse(result.value) as {
        stage: string
        code?: string
        requests?: MobileRequestDetails[]
      }
    }
    async function phone(action: string, params?: Record<string, unknown>) {
      send(action, params)
      return receive()
    }
    async function desktop(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    try {
      await desktop("relay.testAndSave", { address, token })
      await desktop("thread.subscribe", { threadId, cursor: 0 })
      const { attempt } = mobilePairingViewSchema.parse(await desktop("mobile.pairing.start"))
      if (!attempt?.qr) throw new Error("missing pairing QR")
      send("pair", { qr: attempt.qr })
      const code = await receive()
      const candidate = mobilePairingViewSchema.parse(await desktop("mobile.pairing")).attempt
        ?.candidate
      expect(candidate?.code).toBe(code.code)
      await desktop("mobile.pairing.confirm", {
        id: attempt.id,
        confirmation: candidate?.confirmation,
      })
      expect(await receive()).toEqual({ stage: "ready" })
      expect(await phone("save")).toEqual({ stage: "saved" })

      const { runId } = (await desktop("run.start", { threadId, text: "验收审批和提问" })) as {
        runId: string
      }
      const pending = await phone("pendingRequests", { count: 2, threadId })
      const approval = pending.requests?.find((request) => request.approval)
      const question = pending.requests?.find((request) => request.questions)
      expect(approval).toMatchObject({
        threadId,
        runId,
        approval: { detail: "echo approved", decisions: ["allow-once", "deny"] },
      })
      expect(question).toMatchObject({
        threadId,
        runId,
        questions: [{ multiSelect: true, allowCustomAnswer: false }, { allowCustomAnswer: true }],
      })
      // The request card includes other fields, so pass only its address to the write methods.
      const target = (request: MobileRequestDetails) => ({
        threadId: request.threadId,
        runId: request.runId,
        requestId: request.requestId,
      })
      const approvalTarget = mobileRequestTarget.parse(target(approval!))
      expect(
        await phone("approveRequest", {
          params: { ...approvalTarget, commandId: randomUUID(), decision: "allow-for-session" },
        }),
      ).toEqual({ stage: "failed", code: "INVALID_PARAMS" })
      expect(
        await desktop("run.respondApproval", { ...approvalTarget, decision: "deny" }),
      ).toMatchObject({
        outcome: { state: "applied", decision: "deny" },
      })
      const conflict = { ...approvalTarget, commandId: randomUUID(), decision: "allow-once" }
      expect(await phone("approveRequest", { params: conflict })).toMatchObject({
        receipt: { outcome: { state: "already-handled", decision: "deny" } },
      })
      expect(await phone("pendingRequests", { count: 1, threadId })).toMatchObject({
        requests: [{ requestId: question!.requestId }],
      })
      expect(await phone("timeline", { threadId, requestResult: "已拒绝" })).toMatchObject({
        hasRequestResult: true,
      })

      const questionTarget = target(question!)
      expect(
        await host.call("run.answerQuestion", {
          ...questionTarget,
          answers: ["未提供的选项", "通过桌面提交"],
        }),
      ).toMatchObject({ error: { code: "COMMAND_FAILED" } })
      const invalid = {
        ...questionTarget,
        commandId: randomUUID(),
        answers: [{ selected: ["未提供的选项"] }, { selected: [], custom: "通过手机提交" }],
      }
      expect(await phone("answerRequest", { params: invalid })).toEqual({
        stage: "failed",
        code: "INVALID_PARAMS",
      })
      expect(
        await phone("answerRequest", {
          params: {
            ...questionTarget,
            commandId: randomUUID(),
            answers: [{ selected: ["iOS"] }, { selected: ["模拟器"], custom: "另一种方式" }],
          },
        }),
      ).toEqual({ stage: "failed", code: "INVALID_PARAMS" })
      const answer = {
        ...questionTarget,
        commandId: randomUUID(),
        answers: [{ selected: ["iOS", "Android"] }, { selected: [], custom: "通过手机提交" }],
      }
      const accepted = await phone("answerRequest", { params: answer })
      const actual = ["iOS, Android", "通过手机提交"]
      expect(accepted).toMatchObject({
        receipt: { outcome: { state: "applied", answers: actual } },
      })
      expect(await phone("answerRequest", { params: answer })).toEqual(accepted)
      expect(
        await desktop("run.answerQuestion", {
          ...questionTarget,
          answers: ["iOS", "通过桌面提交"],
        }),
      ).toMatchObject({
        outcome: { state: "already-handled", answers: actual },
      })
      expect(await phone("pendingRequests", { count: 0, threadId })).toEqual({
        stage: "pending",
        requests: [],
      })
      expect(
        await phone("timeline", { threadId, answer: "deny / iOS, Android / 通过手机提交" }),
      ).toMatchObject({
        hasAnswer: true,
      })
      expect(events.filter((event) => event.type === "question.answered")).toMatchObject([
        { runId, payload: { requestId: questionTarget.requestId, answers: actual } },
      ])

      const stopped = (await desktop("run.start", { threadId, text: "验收失效请求" })) as {
        runId: string
      }
      const waiting = await phone("pendingRequests", { count: 2, threadId })
      const stale = waiting.requests!.find((request) => request.approval)!
      await desktop("run.interrupt", { threadId, runId: stopped.runId })
      expect(await phone("pendingRequests", { count: 0, threadId })).toEqual({
        stage: "pending",
        requests: [],
      })
      expect(
        await phone("approveRequest", {
          params: { ...target(stale), commandId: randomUUID(), decision: "allow-once" },
        }),
      ).toMatchObject({ receipt: { outcome: { state: "expired" } } })

      await desktop("run.start", { threadId, text: "验收长答案的回执" })
      const longRun = await phone("pendingRequests", { count: 2, threadId })
      const longQuestion = target(longRun.requests!.find((request) => request.questions)!)
      const longAnswer = "字".repeat(mobileRequestAnswerBytes * 2)
      expect(
        await desktop("run.answerQuestion", { ...longQuestion, answers: ["iOS", longAnswer] }),
      ).toMatchObject({
        outcome: { state: "applied", answers: ["iOS", longAnswer] },
      })
      const late = {
        ...longQuestion,
        commandId: randomUUID(),
        answers: [{ selected: ["iOS"] }, { selected: ["模拟器"] }],
      }
      const preview = await phone("answerRequest", { params: late })
      expect(preview).toMatchObject({
        receipt: {
          outcome: {
            state: "already-handled",
            answers: ["iOS", "字".repeat(350)],
            answersTruncated: true,
          },
        },
      })
      expect(await phone("lookupRequest", { commandId: late.commandId })).toEqual(preview)
      await desktop("run.interrupt", { threadId, runId: longQuestion.runId })

      expect(await phone("disconnect")).toEqual({ stage: "closed" })
      await host.stop()
      host = await startMobileHost(paths)
      await expect.poll(() => phone("reconnect"), { timeout: 8000 }).toEqual({ stage: "ready" })
      expect(await phone("lookupRequest", { commandId: answer.commandId })).toEqual(accepted)
    } finally {
      dart.stdin.end()
      dart.kill()
      await host.stop()
      await rm(dir, { force: true, recursive: true })
    }
  },
  45_000,
)

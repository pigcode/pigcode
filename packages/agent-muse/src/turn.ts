import type { SpawnedMspConnection } from "@muse-code/sdk"
import { promptText, record, stringValue, untilAbort } from "@pigcode/native-agent-runtime"
import type { AgentRuntime, ApprovalDecision, UserInput } from "@pigcode/plugin-sdk"

export async function invokeTurn(
  host: SpawnedMspConnection,
  sessionId: string,
  turnId: string,
  cwd: string,
  input: UserInput,
  runtime: AgentRuntime,
) {
  const connection = host.connection
  let finish!: () => void
  let reject!: (error: unknown) => void
  const completion = new Promise<void>((resolve, fail) => {
    finish = resolve
    reject = fail
  })
  // A request can fail or settle before turn/start acknowledges admission.
  void completion.catch(() => undefined)
  const kinds = new Map<string, string>()
  const accumulated = new Map<string, string>()
  const completed = new Set<string>()
  const answered = new Set<string>()
  const fail = (error: unknown) => reject(error)
  const command = (method: string, params: Record<string, unknown>) =>
    connection.command(method, { sessionId, ...params }, { maxAttempts: 1 })

  async function answer(method: string, params: Record<string, unknown>) {
    if (params.turnId !== turnId || params.subagentOrigin) return
    const approval = method.startsWith("approval/")
    const id = stringValue(approval ? params.approvalId : params.userInputId)
    const stage = JSON.stringify([id, params.currentRequirementId])
    if (!id || answered.has(stage)) return
    answered.add(stage)
    if (approval) {
      const choices = Array.isArray(params.availableChoices)
        ? params.availableChoices.map(record)
        : []
      const match = (name: string, scope = "once") =>
        choices.find((c) => c.decision === name && c.scope === scope)
      const offered = {
        "allow-once": match("approved"),
        "allow-for-session":
          match("approvedForSession", "session") ?? match("approvedPolicyAmendment", "session"),
        deny: match("denied") ?? match("deniedPolicyAmendment") ?? match("abort"),
      }
      const decisions = (Object.keys(offered) as ApprovalDecision[]).filter(
        (decision) => offered[decision],
      )
      if (!decisions.length) throw new Error("Muse did not offer a supported approval decision")
      const decision = await runtime.requestApproval({
        toolName: stringValue(params.toolName) || "Muse",
        input: params.subject ?? params.rawArgs,
        decisions,
      })
      const choice = offered[decision]
      if (!choice) throw new Error("Muse did not offer the requested approval decision")
      runtime.signal.throwIfAborted()
      await command("approval/decide", {
        approvalId: id,
        requirementId: params.currentRequirementId,
        choiceId: choice.choiceId,
      })
    } else {
      const questions = Array.isArray(params.questions) ? params.questions.map(record) : []
      const mapped = questions.map((q) => ({
        header: stringValue(q.header),
        question: stringValue(q.prompt) || stringValue(q.question),
        options: Array.isArray(q.options)
          ? q.options.map(record).map((o) => ({
              label: stringValue(o.label),
              description: stringValue(o.description),
            }))
          : [],
        multiSelect: record(q.selection).mode === "multiple",
        allowCustomAnswer: true,
      }))
      const values = (await runtime.askQuestions?.({ questions: mapped }, runtime.signal)) ?? []
      runtime.signal.throwIfAborted()
      if (values.length !== questions.length || values.some((v) => !v.trim())) {
        await command("userInput/cancel", { userInputId: id })
        return
      }
      const answers = questions.map((q, i) => {
        const question = mapped[i]!
        const valuesForQuestion = question.multiSelect ? values[i]!.split(", ") : [values[i]!]
        const selected = valuesForQuestion.filter((v) =>
          question.options.some((o) => o.label === v),
        )
        const custom = valuesForQuestion.filter((v) => !selected.includes(v)).join("\n")
        return {
          questionId: q.id,
          ...(selected.length
            ? question.multiSelect
              ? { selectedLabels: selected }
              : { selectedLabel: selected[0] }
            : {}),
          ...(custom ? (selected.length ? { note: custom } : { freeText: custom }) : {}),
        }
      })
      await command("userInput/answer", { userInputId: id, answers })
    }
  }
  connection.onServerRequest(async ({ method }) => {
    if (method === "approval/request" || method === "userInput/request") return {}
    throw new Error("Unsupported Muse request: " + method)
  })
  connection.onProtocolError(fail)
  connection.onNotification(({ method, params }) => {
    const data = record(params)
    if (runtime.signal.aborted || data.sessionId !== sessionId) return
    if (
      method === "approval/requested" ||
      method === "approval/updated" ||
      method === "userInput/requested"
    ) {
      void answer(method, data).catch(fail)
      return
    }
    const item = record(data.item)
    const id = stringValue(item.itemId) || stringValue(data.itemId)
    if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      if (item.turnId !== turnId && !kinds.has(id)) return
      const kind = stringValue(item.kind)
      kinds.set(id, kind)
      if (method === "item/started" && kind === "toolCall")
        runtime.emit({
          type: "tool.started",
          toolCallId: id,
          name: stringValue(item.tool) || "Muse",
          input: item.args ?? {},
        })
      if (method !== "item/completed" || completed.has(id)) return
      completed.add(id)
      const text =
        stringValue(item.text) ||
        (Array.isArray(item.summary)
          ? item.summary.filter((x) => typeof x === "string").join("\n")
          : "") ||
        accumulated.get(id) ||
        ""
      if (kind === "agentMessage" && text) runtime.emit({ type: "message.completed", text })
      if (kind === "reasoning" && text) runtime.emit({ type: "reasoning.completed", text })
      if (kind === "toolCall")
        runtime.emit({
          type: "tool.completed",
          toolCallId: id,
          name: stringValue(item.tool) || "Muse",
          output: item.visibleOutput ?? item.failureReason ?? null,
          isError: item.status !== "completed",
        })
    } else if (method === "item/delta" && id && !completed.has(id)) {
      const kind = kinds.get(id),
        delta = stringValue(data.delta)
      if (!delta || !kind) return
      const field = stringValue(data.field) || "text"
      if (
        (kind === "agentMessage" && field === "text") ||
        (kind === "reasoning" && (field === "text" || field.startsWith("summary.")))
      ) {
        accumulated.set(id, (accumulated.get(id) ?? "") + delta)
        runtime.emit({
          type: kind === "agentMessage" ? "message.delta" : "reasoning.delta",
          text: delta,
        })
      } else if (kind === "toolCall" && (field === "output" || field === "visibleOutput"))
        runtime.emit({ type: "tool.outputDelta", toolCallId: id, delta })
    } else if (method === "turn/completed" && data.turnId === turnId) {
      if (data.usage) runtime.emit({ type: "usage.updated", usage: data.usage })
      if (data.terminal === "cancelled") runtime.emit({ type: "run.interrupted" })
      if (data.terminal === "completed" || data.terminal === "cancelled") finish()
      else
        fail(
          new Error(
            stringValue(record(data.error).message) ||
              stringValue(data.reason) ||
              "Muse turn failed",
          ),
        )
    }
  })
  void connection.closed.then(
    () => fail(new Error("Muse connection closed before the turn completed")),
    fail,
  )
  const starting = connection.command(
    "turn/start",
    {
      sessionId,
      input: [{ type: "text", text: promptText(input) }],
      workspaceRoots: [cwd],
      displayText: input.text,
      ifBusy: "queue",
      ...(input.effort ? { reasoningEffort: input.effort } : {}),
    },
    { commandId: turnId },
  )
  const receipt = await untilAbort(
    starting,
    AbortSignal.any([runtime.signal, AbortSignal.timeout(30_000)]),
  )
  if (receipt.turnId !== turnId)
    throw new Error("Muse admitted the turn under an unexpected identity")
  await untilAbort(completion, runtime.signal)
}

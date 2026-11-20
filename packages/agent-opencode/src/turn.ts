import { randomUUID } from "node:crypto"
import { promptText, record, stringValue } from "@pigcode/native-agent-runtime"
import type { AgentRuntime, UserInput } from "@pigcode/plugin-sdk"
import type { ServerApi } from "./server"
import { serverEvents } from "./events"

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(record) : []
}
const options = (row: Record<string, unknown>) =>
  rows(row.options).map((opt) => ({
    label: stringValue(opt.label),
    description: stringValue(opt.description),
  }))
const splitAnswer = (answer: string, multiple: boolean) =>
  multiple ? answer.split(", ").filter(Boolean) : [answer]

async function answerV2Form(
  form: Record<string, unknown>,
  api: ServerApi,
  path: string,
  runtime: AgentRuntime,
  signal: AbortSignal,
) {
  const formPath = path + "/form/" + encodeURIComponent(stringValue(form.id))
  const fields = rows(form.fields)
  // External links and conditionally hidden controls need the vendor's form UI.
  if (
    !runtime.askQuestions ||
    fields.some((f) => f.type === "external" || f.hidden === true || Array.isArray(f.when))
  ) {
    await api.json(formPath, "DELETE", signal)
    return
  }
  const answers = await runtime.askQuestions(
    {
      questions: fields.map((f) => ({
        header: stringValue(form.title) || "OpenCode",
        question: stringValue(f.title) || stringValue(f.key),
        multiSelect: f.type === "multiselect",
        allowCustomAnswer: !Array.isArray(f.options) || f.custom === true,
        options:
          f.type === "boolean"
            ? [
                { label: "true", description: "" },
                { label: "false", description: "" },
              ]
            : options(f),
      })),
    },
    signal,
  )
  signal.throwIfAborted()
  if (!answers.length) {
    await api.json(formPath, "DELETE", signal)
    return
  }
  const result: Record<string, unknown> = {}
  fields.forEach((f, index) => {
    const answer = answers[index]
    if (answer === undefined || answer === "") return
    const pick = (label: string) => rows(f.options).find((o) => o.label === label)?.value ?? label
    result[stringValue(f.key)] =
      f.type === "multiselect"
        ? splitAnswer(answer, true).map(pick)
        : f.type === "integer" || f.type === "number"
          ? Number(answer)
          : f.type === "boolean"
            ? answer === "true"
            : pick(answer)
  })
  await api.json(formPath + "/reply", "POST", signal, { answer: result })
}

export async function runOpenCodeTurn(
  api: ServerApi,
  id: string,
  cwd: string,
  input: UserInput,
  runtime: AgentRuntime,
  grants: Set<string>,
  agent: string,
  model: { id: string; providerID: string } | undefined,
  registerInterrupt: (cancel: () => Promise<void>) => void,
) {
  const v2 = api.major === 2
  const path = (v2 ? "/api/session/" : "/session/") + encodeURIComponent(id)
  const sessionStream = new AbortController()
  const signal = AbortSignal.any([runtime.signal, sessionStream.signal])
  const events = await api.request(
    v2 ? "/api/event" : "/event",
    "GET",
    signal,
    undefined,
    v2 ? undefined : cwd,
    true,
  )
  const messageID = "msg_" + randomUUID().replaceAll("-", "")
  const kinds = new Map<string, string>()
  const toolNames = new Map<string, string>()
  const seenTools = new Set<string>()
  const seenResults = new Set<string>()
  let owned = false
  let sent = false
  const interrupt = async () => {
    if (!sent) return
    const queued = v2 && !owned
    const route = queued
      ? path + "/inbox/" + encodeURIComponent(messageID)
      : path + (v2 ? "/interrupt" : "/abort")
    await api
      .json(route, queued ? "DELETE" : "POST", AbortSignal.timeout(4_000), undefined, cwd)
      .catch(() => undefined)
  }
  registerInterrupt(interrupt)
  const receive = async () => {
    for await (const event of serverEvents(events)) {
      const type = stringValue(event.type)
      const data = record(v2 ? event.data : event.properties)
      if (v2 && type === "form.created") {
        const form = record(data.form)
        if (owned && form.sessionID === id) await answerV2Form(form, api, path, runtime, signal)
        continue
      }
      if (data.sessionID !== id) continue
      if (v2) {
        if (data.inboxID === messageID) {
          if (type === "session.inbox.cancelled") {
            runtime.emit({ type: "run.interrupted" })
            return
          }
          if (type === "session.inbox.delivered") owned = true
        }
        if (!owned) continue
      }
      if (type === "permission.asked") {
        const name = stringValue(v2 ? data.action : data.permission)
        const resources = v2 ? data.resources : data.patterns
        const grant = JSON.stringify([name, resources])
        const decision = grants.has(grant)
          ? "allow-once"
          : await runtime.requestApproval({
              toolName: name,
              input: { resources, metadata: data.metadata },
            })
        signal.throwIfAborted()
        if (decision === "allow-for-session") grants.add(grant)
        const reply = decision === "deny" ? "reject" : "once"
        const req = encodeURIComponent(stringValue(data.id))
        await api.json(
          v2 ? path + "/permission/" + req + "/reply" : "/permission/" + req + "/reply",
          "POST",
          signal,
          v2 ? { decision: reply } : { reply },
          v2 ? undefined : cwd,
        )
      } else if (!v2 && type === "question.asked") {
        const questions = rows(data.questions)
        const answers =
          (await runtime.askQuestions?.(
            {
              questions: questions.map((q) => ({
                header: stringValue(q.header),
                question: stringValue(q.question),
                multiSelect: q.multiple === true,
                allowCustomAnswer: q.custom !== false,
                options: options(q),
              })),
            },
            signal,
          )) ?? []
        signal.throwIfAborted()
        const request = "/question/" + encodeURIComponent(stringValue(data.id))
        if (answers.length)
          await api.json(
            request + "/reply",
            "POST",
            signal,
            { answers: answers.map((a, i) => splitAnswer(a, questions[i]?.multiple === true)) },
            cwd,
          )
        else await api.json(request + "/reject", "POST", signal, undefined, cwd)
      } else if (v2) {
        const callId = stringValue(data.id)
        switch (type) {
          case "session.text.delta":
            runtime.emit({ type: "message.delta", text: stringValue(data.delta) })
            break
          case "session.text.ended":
            runtime.emit({ type: "message.completed", text: stringValue(data.text) })
            break
          case "session.reasoning.delta":
            runtime.emit({ type: "reasoning.delta", text: stringValue(data.delta) })
            break
          case "session.reasoning.ended":
            runtime.emit({ type: "reasoning.completed", text: stringValue(data.text) })
            break
          case "session.tool.input.started":
            toolNames.set(callId, stringValue(data.name))
            break
          case "session.tool.called":
            runtime.emit({
              type: "tool.started",
              toolCallId: callId,
              name: toolNames.get(callId) ?? "OpenCode",
              input: data.input,
            })
            break
          case "session.tool.success":
          case "session.tool.failed":
            runtime.emit({
              type: "tool.completed",
              toolCallId: callId,
              name: toolNames.get(callId) ?? "OpenCode",
              output: data.content ?? data.error,
              isError: type === "session.tool.failed",
            })
            break
          case "session.step.ended":
            if (data.tokens) runtime.emit({ type: "usage.updated", usage: data.tokens })
            break
          case "session.execution.succeeded":
            return
          case "session.execution.interrupted":
            runtime.emit({ type: "run.interrupted" })
            return
          case "session.execution.failed":
            throw new Error(stringValue(record(data.error).message) || "OpenCode execution failed")
        }
      } else if (type === "message.part.updated") {
        const part = record(data.part)
        if (part.messageID === messageID) continue
        const partId = stringValue(part.id)
        kinds.set(partId, stringValue(part.type))
        if (part.type === "tool") {
          const state = record(part.state),
            call = stringValue(part.callID) || partId,
            name = stringValue(part.tool) || "OpenCode"
          if (!seenTools.has(call) && state.status !== "pending") {
            seenTools.add(call)
            runtime.emit({ type: "tool.started", toolCallId: call, name, input: state.input })
          }
          if (
            !seenResults.has(call) &&
            (state.status === "completed" || state.status === "error")
          ) {
            seenResults.add(call)
            runtime.emit({
              type: "tool.completed",
              toolCallId: call,
              name,
              output: state.output ?? state.error,
              isError: state.status === "error",
            })
          }
        }
      } else if (
        type === "message.part.delta" &&
        data.messageID !== messageID &&
        data.field === "text"
      ) {
        const partType = kinds.get(stringValue(data.partID))
        runtime.emit({
          type: partType === "reasoning" ? "reasoning.delta" : "message.delta",
          text: stringValue(data.delta),
        })
      }
    }
  }
  const stream = receive()
  void stream.catch(() => undefined)
  try {
    runtime.signal.throwIfAborted()
    if (v2) {
      if (model && input.effort)
        await api.json(path + "/model", "POST", signal, {
          model: { ...model, variant: input.effort },
        })
      sent = true
      const submitted = api.json(path + "/prompt", "POST", signal, {
        id: messageID,
        text: promptText(input),
      })
      await Promise.all([submitted, stream])
    } else {
      sent = true
      const message = api.json(
        path + "/message",
        "POST",
        signal,
        {
          messageID,
          parts: [{ type: "text", text: promptText(input) }],
          agent,
          ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
          ...(input.effort ? { variant: input.effort } : {}),
        },
        cwd,
      )
      const response = record(await Promise.race([message, stream]))
      const info = record(response.info)
      if (info.error)
        throw new Error(
          stringValue(record(record(info.error).data).message) ||
            stringValue(record(info.error).name) ||
            "OpenCode turn failed",
        )
      for (const part of rows(response.parts)) {
        if (part.type === "text" || part.type === "reasoning")
          runtime.emit({
            type: part.type === "text" ? "message.completed" : "reasoning.completed",
            text: stringValue(part.text),
          })
      }
      if (info.tokens) runtime.emit({ type: "usage.updated", usage: info.tokens })
    }
  } catch (error) {
    if (!runtime.signal.aborted) await interrupt()
    throw error
  } finally {
    sessionStream.abort()
    // A permission dialogue may still be waiting for the host to settle the run.
    void stream.catch(() => undefined)
  }
}

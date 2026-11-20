import type { AgentRuntime } from "@pigcode/plugin-sdk"
import { PiRpc, record, string, type PiRecord } from "./rpc"

const dialogs = new Set(["confirm", "select", "input", "editor"])

export async function answerDialog(
  rpc: PiRpc,
  event: PiRecord,
  runtime: AgentRuntime | undefined,
  grants: Set<string>,
) {
  const id = string(event.id),
    method = string(event.method)
  if (!id || !dialogs.has(method)) return
  let response: PiRecord = { cancelled: true }
  if (runtime && !runtime.signal.aborted) {
    const title = string(event.title) || method
    if (method === "confirm") {
      const message = string(event.message)
      const name = /^Allow (.+)\?$/.exec(title)?.[1] ?? "Pi"
      let input: unknown = message
      try {
        input = JSON.parse(message)
      } catch {
        /* Pi extensions may ask in plain text. */
      }
      const key = JSON.stringify([title, message])
      const decision = grants.has(key)
        ? "allow-once"
        : await runtime.requestApproval({ toolName: name, input, title })
      if (decision === "allow-for-session" && !message.endsWith("…")) grants.add(key)
      response = { confirmed: decision !== "deny" }
    } else if (runtime.askQuestions) {
      const choices = Array.isArray(event.options)
        ? event.options.filter((v): v is string => typeof v === "string")
        : []
      const [answer] = await runtime.askQuestions({
        questions: [
          {
            question: title,
            multiSelect: false,
            options: choices.map((label) => ({ label })),
            allowCustomAnswer: method !== "select",
          },
        ],
      })
      if (typeof answer === "string" && (method !== "select" || choices.includes(answer)))
        response = { value: answer }
    }
  }
  if (!rpc.signal.aborted)
    await rpc.write({
      type: "extension_ui_response",
      id,
      ...(runtime?.signal.aborted ? { cancelled: true } : response),
    })
}

/** Pi 的 message_end 给最终内容，agent_settled 才包含自动重试后的最终状态。 */
export class PiTurn {
  private error: string | undefined
  private partial = { text: "", thinking: "" }

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly rpc: PiRpc,
    private readonly grants: Set<string>,
  ) {}

  event(value: PiRecord) {
    switch (value.type) {
      case "extension_ui_request":
        void answerDialog(this.rpc, value, this.runtime, this.grants).catch(() => {
          if (!this.rpc.signal.aborted)
            void this.rpc
              .write({ type: "extension_ui_response", id: value.id, cancelled: true })
              .catch(() => undefined)
        })
        break
      case "message_start":
        if (record(value.message).role === "assistant") this.partial = { text: "", thinking: "" }
        break
      case "message_update": {
        const event = record(value.assistantMessageEvent),
          delta = string(event.delta)
        if (event.type === "text_delta" && delta) {
          this.partial.text += delta
          this.runtime.emit({ type: "message.delta", text: delta })
        }
        if (event.type === "thinking_delta" && delta) {
          this.partial.thinking += delta
          this.runtime.emit({ type: "reasoning.delta", text: delta })
        }
        break
      }
      case "message_end": {
        const message = record(value.message)
        if (message.role !== "assistant") break
        const blocks = Array.isArray(message.content) ? message.content.map(record) : []
        const thought =
          blocks
            .filter((block) => block.type === "thinking")
            .map((block) => string(block.thinking))
            .join("") || this.partial.thinking
        const text =
          blocks
            .filter((block) => block.type === "text")
            .map((block) => string(block.text))
            .join("") || (typeof message.content === "string" ? message.content : this.partial.text)
        if (thought) this.runtime.emit({ type: "reasoning.completed", text: thought })
        if (text) this.runtime.emit({ type: "message.completed", text })
        if (message.usage) this.runtime.emit({ type: "usage.updated", usage: message.usage })
        this.error =
          message.stopReason === "error"
            ? string(message.errorMessage) || "Pi could not complete the turn"
            : undefined
        break
      }
      case "tool_execution_start": {
        const toolCallId = string(value.toolCallId)
        if (toolCallId)
          this.runtime.emit({
            type: "tool.started",
            toolCallId,
            name: string(value.toolName) || "Pi",
            input: value.args ?? {},
          })
        break
      }
      case "tool_execution_end": {
        const toolCallId = string(value.toolCallId)
        if (toolCallId)
          this.runtime.emit({
            type: "tool.completed",
            toolCallId,
            name: string(value.toolName) || "Pi",
            output: value.result ?? "",
            isError: value.isError === true,
          })
        break
      }
      case "auto_retry_end":
        this.error =
          value.success === false
            ? string(value.finalError) || "Pi exhausted its retries"
            : undefined
        break
      case "agent_settled":
        if (this.error && !this.runtime.signal.aborted && value.aborted !== true)
          throw new Error(this.error)
        return value.aborted === true ? ("aborted" as const) : ("completed" as const)
    }
    return undefined
  }
}

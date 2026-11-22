import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk"
import type { AgentRuntime } from "@pigcode/plugin-sdk"
import type { RuntimeMode } from "@pigcode/contracts"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function valueText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function limit(text: string): string {
  return text.length > 32_000 ? text.slice(0, 32_000) + "\n…" : text
}

const labels: Partial<Record<ToolKind, string>> = {
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  move: "Edit",
  delete: "Edit",
  search: "Search",
  fetch: "WebFetch",
  switch_mode: "SwitchMode",
}

function toolName(tool: ToolCallUpdate): string {
  const title = tool.title
    ?.replace(/^(?:Running|Run)\s+/i, "")
    .replace(/\?$/, "")
    .trim()
  const native = tool.name || title
  const mcp = /^(?:mcp__)?pigcode(?:__|[./])([\w-]+)$/.exec(native ?? "")
  return mcp ? `mcp__pigcode__${mcp[1]}` : (tool.kind && labels[tool.kind]) || native || "Tool"
}

function toolInput(tool: ToolCallUpdate) {
  const raw = record(tool.rawInput)
  const command = valueText(raw.CommandLine ?? raw.command_line ?? raw.commandLine ?? raw.command)
  const cwd = valueText(raw.Cwd ?? raw.WorkingDirectory ?? raw.working_dir ?? raw.cwd)
  const path =
    tool.locations?.[0]?.path ?? valueText(raw.absolute_path ?? raw.file_path ?? raw.path)
  const diff = tool.content?.find((content) => content.type === "diff")
  if (diff?.type === "diff" && diff.newText.length + (diff.oldText?.length ?? 0) <= 32_000) {
    return { file_path: diff.path, old_string: diff.oldText ?? "", new_string: diff.newText }
  }
  return {
    ...Object.fromEntries(
      Object.entries(raw)
        .slice(0, 24)
        .flatMap<[string, string | number | boolean]>(([key, value]) =>
          typeof value === "string"
            ? [[key, limit(value)]]
            : typeof value === "number" || typeof value === "boolean"
              ? [[key, value]]
              : [],
        ),
    ),
    ...(tool.title ? { title: limit(tool.title) } : {}),
    ...(command ? { command: limit(command) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(path ? { file_path: path } : {}),
  }
}

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } })
const mutationKinds = new Set(["edit", "delete", "move"])

export async function answerPermission(
  request: RequestPermissionRequest,
  runtime: AgentRuntime,
  mode: RuntimeMode,
  plan: boolean,
  grants: Set<string>,
): Promise<RequestPermissionResponse> {
  if (runtime.signal.aborted) return cancelled()
  const { toolCall, options } = request
  const select = (optionId: string): RequestPermissionResponse => ({
    outcome: { outcome: "selected", optionId },
  })
  if (toolCall.toolCallId.startsWith("interaction_")) {
    if (!runtime.askQuestions || options.length === 0) return cancelled()
    const unique = new Set<string>()
    const choices = options.map((option) => {
      const label = option.name.trim() || option.optionId
      const uniqueLabel = unique.has(label) ? `${label} (${option.optionId})` : label
      unique.add(uniqueLabel)
      return { label: uniqueLabel, optionId: option.optionId }
    })
    const [answer] = await runtime.askQuestions({
      questions: [
        {
          question: toolCall.title ?? "Agent question",
          multiSelect: false,
          allowCustomAnswer: false,
          options: choices.map(({ label }) => ({ label })),
        },
      ],
    })
    const selected = choices.find((choice) => choice.label === answer)
    return selected && !runtime.signal.aborted ? select(selected.optionId) : cancelled()
  }
  const once = options.find((option) => option.kind === "allow_once")
  const reject = options.find((option) => option.kind === "reject_once")
  const name = toolName(toolCall)
  const input = toolInput(toolCall)
  const planConfirmation =
    toolCall.kind === "switch_mode" ||
    /(?:review|approve|confirm).*plan|plan.*(?:review|approve|confirm)/i.test(toolCall.title ?? "")
  const key =
    (toolCall.kind || toolCall.name) &&
    toolCall.rawInput !== undefined &&
    toolCall.rawInput !== null
      ? JSON.stringify([
          toolCall.kind,
          toolCall.name,
          toolCall.title,
          toolCall.locations,
          toolCall.rawInput,
        ])
      : null
  if (
    once &&
    !plan &&
    !planConfirmation &&
    (mode === "full-access" ||
      (mode === "auto-accept-edits" && mutationKinds.has(toolCall.kind ?? "")) ||
      (key !== null && grants.has(key)))
  )
    return select(once.optionId)
  const decision = await runtime.requestApproval({
    toolName: name,
    input,
    ...(toolCall.title ? { title: toolCall.title } : {}),
    decisions: once
      ? key && !plan && !planConfirmation
        ? ["allow-once", "allow-for-session", "deny"]
        : ["allow-once", "deny"]
      : ["deny"],
  })
  if (runtime.signal.aborted) return cancelled()
  if (decision === "deny") return reject ? select(reject.optionId) : cancelled()
  if (!once) return cancelled()
  if (decision === "allow-for-session" && key && !plan && !planConfirmation) grants.add(key)
  return select(once.optionId)
}

export class TurnEvents {
  private readonly tools = new Map<string, ToolCallUpdate>()
  private readonly completed = new Set<string>()
  private chunk:
    { type: "message" | "reasoning"; text: string; id?: string | null | undefined } | undefined

  constructor(private readonly runtime: AgentRuntime) {}

  update(event: SessionUpdate) {
    switch (event.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (event.content.type !== "text") return
        const type = event.sessionUpdate === "agent_message_chunk" ? "message" : "reasoning"
        if (this.chunk?.type !== type || this.chunk.id !== event.messageId) {
          this.flush()
          this.chunk = { type, text: "", id: event.messageId }
        }
        this.chunk.text += event.content.text
        this.runtime.emit({
          type: type === "message" ? "message.delta" : "reasoning.delta",
          text: event.content.text,
        })
        return
      }
      case "tool_call":
      case "tool_call_update":
        this.tool(event)
        return
      case "plan":
        this.runtime.emit({ type: "plan.updated", plan: event.entries, explanation: null })
        return
      case "usage_update":
        if (Number.isSafeInteger(event.used) && event.used >= 0)
          this.runtime.emit({
            type: "context.updated",
            usedTokens: event.used,
            maxTokens: Number.isSafeInteger(event.size) && event.size > 0 ? event.size : null,
            autoCompactTokens: null,
          })
        if (event.cost) this.runtime.emit({ type: "usage.updated", usage: event.cost })
        return
    }
  }

  finish() {
    this.flush()
    for (const tool of this.tools.values()) this.tool({ ...tool, status: "failed" })
  }

  private flush() {
    if (!this.chunk) return
    const { type, text } = this.chunk
    this.chunk = undefined
    if (text)
      this.runtime.emit({
        type: type === "message" ? "message.completed" : "reasoning.completed",
        text,
      })
  }

  private tool(update: ToolCallUpdate) {
    const id = update.toolCallId
    if (id.startsWith("interaction_") || this.completed.has(id)) return
    const previous = this.tools.get(id)
    const tool = { ...previous, ...update }
    this.tools.set(id, tool)
    const name = toolName(tool)
    if (!previous) {
      this.flush()
      this.runtime.emit({ type: "tool.started", toolCallId: id, name, input: toolInput(tool) })
    }
    if (tool.status !== "completed" && tool.status !== "failed") return
    this.tools.delete(id)
    this.completed.add(id)
    const output = record(tool.rawOutput)
    const text =
      valueText(output.combinedOutput ?? output.combined_output ?? tool.rawOutput) ??
      tool.content
        ?.flatMap((item) =>
          item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
        )
        .join("\n")
    const exitCode = output.exitCode ?? output.exit_code
    this.runtime.emit({
      type: "tool.completed",
      toolCallId: id,
      name,
      output: text === undefined ? null : limit(text),
      isError: tool.status === "failed",
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
    })
  }
}

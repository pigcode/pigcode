#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const log = (value: object) =>
  appendFileSync(process.env.MUSE_TEST_LOG!, JSON.stringify(value) + "\n")
log({ args: process.argv.slice(2) })
if (process.argv.includes("--version")) {
  process.stdout.write("1.4.6\n")
  process.exit(0)
}

const line = (frame: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n")
const notify = (method: string, params: object) => line({ method, params })
let turnId = ""
let sessionId = ""
for await (const input of createInterface({ input: process.stdin })) {
  const {
    id,
    method,
    params,
  }: { id?: string | number; method: string; params: Record<string, string> } = JSON.parse(input)
  if (id === undefined) continue
  log({ method, params })
  const acknowledge = (result: object) => line({ id, result })
  const item = { turnId, itemId: "message", kind: "agentMessage", status: "inProgress" }
  switch (method) {
    case "initialize":
      acknowledge({
        schema: { version: 1, fingerprint: "test" },
        grantedCapabilities: ["sessionMcp"],
      })
      break
    case "model/list":
      acknowledge({
        providerId: "meta",
        models: [
          {
            providerId: "meta",
            modelId: "test-model",
            displayLabel: "Test Muse",
            isDefault: true,
            variants: ["low", "high"],
          },
        ],
      })
      break
    case "session/start":
      sessionId = params.sessionId!
      writeFileSync(join(process.cwd(), sessionId), "native")
      acknowledge({ session: { sessionId, approvalMode: { mode: params.approvalMode } } })
      break
    case "session/resume":
      sessionId = params.sessionId!
      if (existsSync(join(process.cwd(), sessionId))) acknowledge({ session: { sessionId } })
      else
        line({
          id,
          error: { code: -32000, message: "no native session", data: { kind: "sessionNotFound" } },
        })
      break
    case "session/setApprovalMode":
      acknowledge({ effectiveMode: { mode: process.env.MUSE_TEST_BAD_MODE || params.mode } })
      break
    case "turn/start":
      turnId = params.commandId!
      acknowledge({ turnId, commandId: turnId })
      if (params.displayText === "hold") break
      notify("approval/requested", {
        sessionId,
        turnId,
        approvalId: "approval",
        currentRequirementId: "requirement",
        toolName: "shell",
        subject: { command: "demo" },
        availableChoices: [
          { decision: "approved", scope: "once", choiceId: "once" },
          { decision: "denied", scope: "once", choiceId: "no" },
        ],
      })
      break
    case "approval/decide":
      acknowledge({})
      notify("userInput/requested", {
        sessionId,
        turnId,
        userInputId: "question",
        questions: [
          {
            id: "features",
            header: "Choose",
            question: "Which ones?",
            selection: { mode: "multiple" },
            options: [{ label: "Alpha" }, { label: "Beta" }],
          },
        ],
      })
      break
    case "userInput/answer":
      acknowledge({})
      notify("item/started", { sessionId, item: { ...item, turnId: "foreign", itemId: "other" } })
      notify("item/delta", { sessionId, itemId: "other", delta: "foreign" })
      notify("item/started", { sessionId, item })
      notify("item/delta", { sessionId, itemId: item.itemId, field: "text", delta: "confirmed" })
      notify("item/completed", {
        sessionId,
        item: { ...item, text: "confirmed", status: "completed" },
      })
      notify("turn/completed", {
        sessionId,
        turnId,
        terminal: "completed",
        usage: { outputTokens: 1 },
      })
      break
    default:
      acknowledge({})
  }
}

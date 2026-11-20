#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const cliData = process.env.PIGCODE_AGY_FIXTURE_CLI_DATA
const cliSignedIn = Boolean(cliData && !process.env.SSH_CONNECTION)
if (args.includes("--version")) {
  console.log("1.5.13")
  process.exit(0)
}
if (args[0] === "models") {
  if (cliSignedIn) console.log("cli-model\tCLI model")
  process.exit(cliSignedIn ? 0 : 1)
}
function getArg(name: string): string {
  const value = args[args.indexOf(name) + 1]
  if (!value) throw new Error("Missing fixture option: " + name)
  return value
}
const directory = args.includes("--gemini-dir")
  ? join(getArg("--gemini-dir"), getArg("--app-data-dir"))
  : cliData
if (!directory) throw new Error("Missing fixture profile")
const token = join(directory, "acp_token.json")
mkdirSync(directory, { recursive: true })
const lines = createInterface({ input: process.stdin })
if (args.includes("--login")) {
  if (cliData && !process.env.SSH_CONNECTION)
    throw new Error("Separate sign-in requires file storage")
  console.log(
    "https://accounts.google.com/o/oauth2/auth?state=fixture&response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback",
  )
  lines.once("line", (line) => {
    if (!["personal", "work", "pending"].includes(line)) process.exit(1)
    writeFileSync(token, line, { mode: 0o600 })
    process.exit(0)
  })
} else {
  type Id = string | number
  interface Message {
    id?: Id
    method?: string
    params?: {
      sessionId?: string
      prompt?: Array<{ text: string }>
      mcpServers?: Array<{ type?: string; url?: string }>
    }
    result?: { outcome?: { optionId?: string } }
  }
  const send = (message: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
  const update = (sessionId: string, value: object) =>
    send({ method: "session/update", params: { sessionId, update: value } })
  const sessions = new Set<string>()
  const httpMcp = new Map<string, string>()
  const replies = new Map<Id, (optionId?: string) => void>()
  lines.on("line", (line) => {
    const { id, method, params = {}, result: response } = JSON.parse(line) as Message
    if (!method) {
      if (id === undefined) return
      const finish = replies.get(id)
      replies.delete(id)
      finish?.(response?.outcome?.optionId)
      return
    }
    const result = (value: unknown) => send({ id, result: value })
    const error = (code: number, message: string) => send({ id, error: { code, message } })
    if (method === "initialize") {
      result({
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
        agentCapabilities: {
          sessionCapabilities: { resume: {}, close: {} },
          auth: { logout: {} },
          ...(args.includes("--process-per-session") ? { mcpCapabilities: { http: true } } : {}),
        },
        authMethods: [],
      })
      return
    }
    if (method === "logout") {
      rmSync(token, { force: true })
      result({})
      return
    }
    let account
    try {
      account = readFileSync(token, "utf8")
    } catch {
      if (!cliSignedIn) {
        if (id !== undefined) error(-32000, "Authentication required")
        return
      }
      account = "cli"
    }
    const configOptions = [
      {
        id: "model",
        category: "model",
        type: "select",
        name: "Model",
        currentValue: account + "-model",
        options: [{ value: account + "-model", name: account + " model" }],
      },
    ]
    if (method === "session/new" || method === "session/resume") {
      if (account === "pending") {
        const marker = process.env.PIGCODE_AGY_FIXTURE_VERIFYING
        if (marker) writeFileSync(marker, "waiting")
        return
      }
      const sessionId = params.sessionId ?? randomUUID()
      if (method === "session/resume") {
        try {
          readFileSync(join(directory, sessionId))
        } catch {
          error(
            -32603,
            "Failed to read session " + sessionId + "; retry, or load it with session/load",
          )
          return
        }
      } else writeFileSync(join(directory, sessionId), account)
      sessions.add(sessionId)
      const bridge = params.mcpServers?.find((server) => server.type === "http")
      if (bridge?.url) httpMcp.set(sessionId, bridge.url)
      result({
        sessionId,
        configOptions,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "auto", name: "Auto" },
            { id: "plan", name: "Plan" },
          ],
        },
      })
      return
    }
    const sessionId = params.sessionId
    if (!sessionId || !sessions.has(sessionId)) return
    if (method === "session/prompt") {
      const prompt = params.prompt?.map((block) => block.text).join("") ?? ""
      const complete = (text: string) => {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        })
        result({ stopReason: "end_turn" })
      }
      const permission = (
        id: Id,
        toolCall: object,
        options: object[],
        reply: (optionId?: string) => void,
      ) => {
        replies.set(id, reply)
        send({
          id,
          method: "session/request_permission",
          params: { sessionId: params.sessionId, toolCall, options },
        })
      }
      if (prompt === "read fixture through MCP") {
        const bridge = httpMcp.get(sessionId)
        if (!bridge) return complete("No HTTP MCP")
        void fetch(bridge, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "fixture_context" },
          }),
        })
          .then((reply) => reply.json())
          .then(
            (body: { result?: { content?: Array<{ text?: string }> } }) =>
              complete(body.result?.content?.[0]?.text ?? "No MCP result"),
            () => complete("MCP bridge unavailable"),
          )
      } else if (prompt === "approve and ask") {
        permission(
          "approval",
          {
            toolCallId: "c1",
            kind: "execute",
            title: "Run echo?",
            rawInput: { CommandLine: "echo test" },
          },
          [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
          (allowed) => {
            if (allowed !== "allow") return complete("Not approved")
            permission(
              "question",
              { toolCallId: "interaction_choice", title: "Which one?" },
              [
                { optionId: "first", kind: "allow_once", name: "First" },
                { optionId: "second", kind: "allow_once", name: "Second" },
              ],
              (choice) => complete("approved: " + choice),
            )
          },
        )
      } else complete(account + ": " + prompt)
    } else if (method === "session/set_config_option") result({ configOptions })
    else if (id !== undefined) result({})
  })
}

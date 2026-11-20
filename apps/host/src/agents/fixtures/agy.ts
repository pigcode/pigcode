#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { createServer } from "node:http"

const args = process.argv.slice(2)
const cliData = process.env.PIGCODE_AGY_FIXTURE_CLI_DATA
const standalone = Boolean(process.env.ANTIGRAVITY_HARNESS_PATH)
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
  : standalone && process.env.GEMINI_HOME
    ? join(process.env.GEMINI_HOME, "antigravity-acp")
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
      methodId?: string
    }
    result?: { outcome?: { optionId?: string } }
  }
  const send = (message: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
  const update = (sessionId: string, value: object) =>
    send({ method: "session/update", params: { sessionId, update: value } })
  const sessions = new Set<string>()
  const httpMcp = new Map<string, string>()
  const replies = new Map<Id, (optionId?: string) => void>()
  let activeCredential: string | undefined
  const profile = cliSignedIn
    ? {}
    : (JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")) as {
        auth?: { type?: string }
        gcp?: { project?: string; location?: string }
      })
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
        authMethods: (standalone
          ? ["oauth-business", "oauth-personal", "gemini-api-key", "agent-platform"]
          : ["gemini-api-key", "agent-platform"]
        ).map((id) => ({ id, name: id })),
      })
      return
    }
    if (method === "logout") {
      rmSync(token, { force: true })
      result({})
      return
    }
    if (method === "authenticate") {
      if (params.methodId !== profile.auth?.type)
        return error(-32602, "Unexpected ACP authentication method")
      if (params.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY) {
        activeCredential = params.methodId
        return result({})
      }
      if (params.methodId === "agent-platform") {
        if (
          standalone
            ? process.env.GOOGLE_API_KEY === "fixture-key"
            : process.env.AGY_ADC_AUTH === "true" &&
              process.env.GOOGLE_APPLICATION_CREDENTIALS === "fixture-adc.json" &&
              process.env.GOOGLE_CLOUD_PROJECT === profile.gcp?.project &&
              process.env.GOOGLE_CLOUD_LOCATION === profile.gcp?.location
        ) {
          activeCredential = params.methodId
          return result({})
        }
        return error(-32603, "Could not load Application Default Credentials")
      }
      if (
        standalone &&
        (params.methodId === "oauth-business" || params.methodId === "oauth-personal")
      ) {
        const listener = createServer((request, reply) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1")
          if (
            url.pathname !== "/" ||
            url.searchParams.get("state") !== "fixture-enterprise" ||
            url.searchParams.get("code") !== "confirmed"
          ) {
            reply.writeHead(400).end()
            return
          }
          writeFileSync(token, params.methodId!, { mode: 0o600 })
          reply.end("ok")
          listener.close()
          result({})
        })
        listener.listen(0, "127.0.0.1", () => {
          const address = listener.address()
          if (!address || typeof address === "string") return
          const link = new URL("https://accounts.google.com/o/oauth2/v2/auth")
          link.search = new URLSearchParams({
            state: "fixture-enterprise",
            response_type: "code",
            redirect_uri: "http://127.0.0.1:" + address.port + "/",
          }).toString()
          console.error("__PIGCODE_ANTIGRAVITY_AUTH__" + JSON.stringify(link.href))
        })
        return
      }
      return error(-32000, "Authentication required")
    }
    let account
    try {
      account = readFileSync(token, "utf8")
    } catch {
      if (!cliSignedIn && !activeCredential) {
        if (id !== undefined) error(-32000, "Authentication required")
        return
      }
      account = activeCredential ?? "cli"
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
      if (account === "gemini-api-key" && process.env.GEMINI_API_KEY !== "fixture-key")
        complete(
          "\n⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT",
        )
      else if (prompt === "read fixture through MCP") {
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

import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import type {
  AgentOptions,
  InteractionUpdate,
  ModelSelection,
  Run,
  SDKAgent,
  SDKModel,
} from "@cursor/sdk"
import type { AgentEvent, RuntimeMode } from "@pigcode/contracts"

export interface CursorWorkerOptions {
  pigcodeCursor: true
  directory: string
  key?: string
}
export type CursorRequest =
  | { op: "status" | "models" | "login" | "logout" | "cancel" | "close" }
  | {
      op: "open"
      cwd: string
      nativeId: string | null
      model: string | null
      plan: boolean
      permission: string
      descriptor?: SDKModel
      mcp?: { command: string; args: string[]; env: Record<string, string> }
    }
  | { op: "send"; text: string; effort?: string; fast?: boolean }
export type CursorReply =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: AgentEvent }
  | { url: string }

// Headless Cursor has no human approval callback. Without a backend classifier
// autoReview reverts to unattended execution, including inside a writable sandbox.
export const cursorExecutionModes = {
  plan: true,
  permissions: ["full-access"] satisfies RuntimeMode[],
}

export function cursorPolicy(permission: string, plan: boolean, platform: NodeJS.Platform) {
  if (permission !== "full-access")
    throw new Error("Cursor does not support runtime permission mode: " + permission)
  const native: Pick<AgentOptions, "mode" | "tools"> = plan
    ? { mode: "plan", tools: ["read", "grep", "glob", "ls"] }
    : { mode: "agent" }
  const local: Pick<
    NonNullable<AgentOptions["local"]>,
    "settingSources" | "sandboxOptions" | "autoReview"
  > = {
    autoReview: false,
    // Windows has no Cursor filesystem sandbox; the SDK's read-only tool allowlist still applies.
    sandboxOptions: { enabled: plan && platform !== "win32" },
    settingSources: plan ? [] : ["project", "user", "team", "mdm", "plugins"],
  }
  return { native, local }
}

async function serve(options: CursorWorkerOptions) {
  const port = parentPort!
  const require = createRequire(import.meta.url)
  const sdk = require("@cursor/sdk") as typeof import("@cursor/sdk")
  const credentialPath = join(options.directory, "cursor-account.json")
  const store = new sdk.FileCredentialStore(credentialPath)
  const key = async () => {
    if (options.key) return options.key
    const saved = await store.load()
    if (saved && (!saved.apiKeyExpiresAtMs || saved.apiKeyExpiresAtMs > Date.now()))
      return saved.apiKey
    return undefined
  }
  let agent: SDKAgent | undefined
  let run: Run | undefined
  let selectedId: string | undefined
  let descriptor: SDKModel | undefined
  function selection(effort?: string, fast = false): ModelSelection | undefined {
    if (!selectedId) return undefined
    const defaults = descriptor?.variants?.find((v) => v.isDefault)?.params ?? []
    const params = descriptor?.parameters?.flatMap((p) => {
      const value =
        p.id === "fast"
          ? String(fast)
          : (p.id === "effort" || p.id === "reasoning") && effort
            ? effort
            : defaults.find((d) => d.id === p.id)?.value
      return value !== undefined ? [{ id: p.id, value }] : []
    })
    return { id: selectedId, ...(params?.length ? { params } : {}) }
  }
  let cancelled = false
  const loginAbort = new AbortController()
  const event = (value: AgentEvent) => port.postMessage({ event: value } satisfies CursorReply)

  async function command(request: CursorRequest): Promise<unknown> {
    switch (request.op) {
      case "status": {
        const apiKey = await key()
        if (!apiKey) return { authenticated: false }
        try {
          const user = await sdk.Cursor.me({ apiKey })
          return {
            authenticated: true,
            email: user.userEmail ?? null,
            account: user.apiKeyName || "Cursor",
          }
        } catch (error) {
          if (error instanceof sdk.AuthenticationError) return { authenticated: false }
          throw error
        }
      }
      case "models": {
        const apiKey = await key()
        return apiKey ? sdk.Cursor.models.list({ apiKey }) : []
      }
      case "login": {
        if (options.key) throw new Error("This Cursor instance uses its configured API key")
        const pending = new sdk.InMemoryCredentialStore()
        await sdk.Cursor.auth.login({
          store: pending,
          signal: loginAbort.signal,
          openBrowser: false,
          apiKeyName: "Pigcode",
          onLoginUrl: (url) => port.postMessage({ url } satisfies CursorReply),
        })
        const credentials = await pending.load()
        if (!credentials) throw new Error("Cursor did not return credentials")
        loginAbort.signal.throwIfAborted()
        await sdk.Cursor.me({ apiKey: credentials.apiKey })
        loginAbort.signal.throwIfAborted()
        const staged = credentialPath + "." + randomUUID() + ".tmp"
        try {
          await new sdk.FileCredentialStore(staged).save(credentials)
          loginAbort.signal.throwIfAborted()
          await rename(staged, credentialPath)
        } finally {
          await rm(staged, { force: true })
        }
        return null
      }
      case "logout":
        if (options.key) throw new Error("This Cursor instance uses its configured API key")
        await sdk.Cursor.auth.logout({ store })
        return null
      case "open": {
        const policy = cursorPolicy(request.permission, request.plan, process.platform)
        const apiKey = await key()
        if (!apiKey)
          throw new Error("Sign in to Cursor or configure CURSOR_API_KEY in Agent settings")
        selectedId = request.model === "auto" ? "default" : (request.model ?? undefined)
        descriptor = request.descriptor
        if (selectedId && !descriptor) {
          const models = await sdk.Cursor.models.list({ apiKey })
          descriptor = models.find((m) => m.id === selectedId)
        }
        const config: AgentOptions = {
          apiKey,
          ...policy.native,
          ...(selectedId ? { model: selection()! } : {}),
          local: {
            cwd: request.cwd,
            store: new sdk.JsonlLocalAgentStore(join(options.directory, "sessions")),
            ...policy.local,
            enableAgentRetries: true,
          },
          ...(!request.plan && request.mcp
            ? { mcpServers: { pigcode: { type: "stdio", ...request.mcp } } }
            : {}),
        }
        try {
          agent = request.nativeId
            ? await sdk.Agent.resume(request.nativeId, config)
            : await sdk.Agent.create(config)
        } catch (error) {
          if (
            request.nativeId &&
            error instanceof Error &&
            /agent.*not found|no (saved )?checkpoint|no such agent/i.test(error.message)
          )
            throw new Error("The native Agent session no longer exists")
          throw error
        }
        return agent.agentId
      }
      case "send": {
        if (!agent) throw new Error("Cursor session is not open")
        let text = ""
        let reasoning = ""
        function delta(update: InteractionUpdate) {
          if (cancelled) return
          switch (update.type) {
            case "text-delta":
              text += update.text
              event({ type: "message.delta", text: update.text })
              break
            case "thinking-delta":
              reasoning += update.text
              event({ type: "reasoning.delta", text: update.text })
              break
            case "thinking-completed":
              if (reasoning) event({ type: "reasoning.completed", text: reasoning })
              reasoning = ""
              break
            case "tool-call-started":
              event({
                type: "tool.started",
                toolCallId: update.callId,
                name: update.toolCall.type,
                input: update.toolCall.args,
              })
              break
            case "tool-call-completed": {
              const result = update.toolCall.result
              event({
                type: "tool.completed",
                toolCallId: update.callId,
                name: update.toolCall.type,
                output: result ?? null,
                isError: Boolean(
                  result &&
                  typeof result === "object" &&
                  ("error" in result || "permissionDenied" in result),
                ),
              })
              break
            }
          }
        }
        run = await agent.send(request.text, {
          ...(selectedId ? { model: selection(request.effort, request.fast)! } : {}),
          onDelta: ({ update }) => delta(update),
        })
        if (cancelled) await run.cancel()
        const result = await run.wait()
        if (cancelled || result.status === "cancelled") {
          event({ type: "run.interrupted" })
          return null
        }
        if (result.status === "error") throw new Error(result.error?.message || "Cursor run failed")
        if (reasoning) event({ type: "reasoning.completed", text: reasoning })
        if (text || result.result)
          event({ type: "message.completed", text: text || result.result! })
        if (result.usage) event({ type: "usage.updated", usage: result.usage })
        return null
      }
      case "cancel":
        cancelled = true
        await run?.cancel()
        return null
      case "close":
        cancelled = true
        loginAbort.abort()
        try {
          if (run?.status === "running") await run.cancel()
        } finally {
          await agent?.[Symbol.asyncDispose]()
        }
        return null
    }
  }
  port.on("message", ({ id, request }: { id: number; request: CursorRequest }) => {
    void command(request).then(
      (result) => port.postMessage({ id, result } satisfies CursorReply),
      (error) =>
        port.postMessage({
          id,
          error: error instanceof Error ? error.message : "Cursor SDK request failed",
        } satisfies CursorReply),
    )
  })
}
if (!isMainThread && workerData?.pigcodeCursor === true) {
  void serve(workerData as CursorWorkerOptions).catch((error: unknown) => {
    throw error
  })
}

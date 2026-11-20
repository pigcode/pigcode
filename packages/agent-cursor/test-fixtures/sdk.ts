import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
interface Credential {
  apiKey: string
}
interface LoginOptions {
  store: InMemoryCredentialStore
  openBrowser: boolean
  onLoginUrl(url: string): void
  signal: AbortSignal
}
interface Options {
  mode: string
  model: unknown
  tools?: string[]
  mcpServers?: unknown
  local: {
    store: JsonlLocalAgentStore
    sandboxOptions: { enabled: boolean }
    autoReview: boolean
    settingSources: string[]
  }
}
const audit = (op: object) =>
  appendFileSync(process.env.CURSOR_TEST_LOG!, JSON.stringify(op) + "\n")
class InMemoryCredentialStore {
  private value?: Credential
  async load() {
    return this.value
  }
  async save(value: Credential) {
    this.value = value
  }
}
class FileCredentialStore {
  constructor(readonly path: string) {}
  async load() {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : undefined
  }
  async save(value: Credential) {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(value))
  }
  async clear() {
    rmSync(this.path, { force: true })
  }
}
class JsonlLocalAgentStore {
  constructor(readonly path: string) {}
}
const Cursor = {
  me: async () => ({ userEmail: "person@example.test", apiKeyName: "test-account" }),
  models: {
    list: async () => [
      {
        id: "model",
        displayName: "SDK model",
        parameters: [
          { id: "effort", values: [{ value: "high" }] },
          { id: "fast", values: [{ value: "true" }, { value: "false" }] },
        ],
        variants: [
          {
            isDefault: true,
            params: [
              { id: "effort", value: "high" },
              { id: "fast", value: "true" },
            ],
          },
        ],
      },
    ],
  },
  auth: {
    login: async ({ store, openBrowser, onLoginUrl, signal }: LoginOptions) => {
      if (openBrowser) throw new Error("must let the client open the address")
      onLoginUrl("https://cursor.example.test/auth")
      while (!existsSync(process.env.CURSOR_TEST_LOGIN!)) await delay(15, undefined, { signal })
      await store.save({ apiKey: "session-credential" })
    },
    logout: async ({ store }: { store: FileCredentialStore }) => store.clear(),
  },
}
function session(agentId: string, config: Options, op: string) {
  const marker = join(config.local.store.path, agentId)
  if (op === "resume" && !existsSync(marker)) throw new Error("Agent not found")
  mkdirSync(config.local.store.path, { recursive: true })
  writeFileSync(marker, "native")
  audit({
    op,
    mode: config.mode,
    model: config.model,
    sandbox: config.local.sandboxOptions.enabled,
    autoReview: config.local.autoReview,
    mcp: config.mcpServers ?? null,
    tools: config.tools ?? null,
    sources: config.local.settingSources,
  })
  return {
    agentId,
    async [Symbol.asyncDispose]() {},
    async send(text: string, options: { model: unknown; onDelta(event: object): void }) {
      audit({ op: "send", text, model: options.model })
      let resolve!: (value: { status: "cancelled" }) => void
      const hold = new Promise<{ status: "cancelled" }>((done) => {
        resolve = done
      })
      const run = {
        status: "running",
        async cancel() {
          audit({ op: "cancel" })
          run.status = "cancelled"
          resolve({ status: "cancelled" })
        },
        async wait() {
          if (text === "hold") return hold
          options.onDelta({ update: { type: "thinking-delta", text: "thinking" } })
          options.onDelta({ update: { type: "thinking-completed" } })
          options.onDelta({ update: { type: "text-delta", text: "response" } })
          options.onDelta({
            update: {
              type: "tool-call-started",
              callId: "tool",
              toolCall: { type: "read", args: { path: "x" } },
            },
          })
          options.onDelta({
            update: {
              type: "tool-call-completed",
              callId: "tool",
              toolCall: { type: "read", result: { text: "x" } },
            },
          })
          run.status = "completed"
          return { status: "completed", result: "response", usage: { output: 1 } }
        },
      }
      return run
    },
  }
}
export { FileCredentialStore, InMemoryCredentialStore, JsonlLocalAgentStore, Cursor }
export class AuthenticationError extends Error {}
export const Agent = {
  create: async (config: Options) => session("cursor-native", config, "create"),
  resume: async (id: string, config: Options) => session(id, config, "resume"),
}

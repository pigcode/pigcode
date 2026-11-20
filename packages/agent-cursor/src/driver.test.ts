import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { expect, it } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import type { AgentInstanceContext } from "@pigcode/plugin-sdk"
import { CursorDriver } from "./driver"
import { cursorPolicy } from "./worker"

function scope(path: string, id: string): AgentInstanceContext {
  return { instanceId: id, dataDir: join(path, id), sharedDir: path, invalidate: () => {} }
}
it("asks the installed Cursor SDK for account and catalog, using just this instance's credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-cursor-sdk-"))
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(req.url ?? "")
    res.setHeader("content-type", "application/json")
    if (req.url === "/v1/me")
      res.end(JSON.stringify({ apiKeyName: "test-key", userEmail: "demo@example.test" }))
    else if (req.url === "/v1/models")
      res.end(JSON.stringify({ items: [{ id: "available", displayName: "SDK model" }] }))
    else {
      res.writeHead(404)
      res.end("{}")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const driver = new CursorDriver()
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("fixture port unavailable")
    const environment = [
      { name: "CURSOR_BACKEND_URL", value: "http://127.0.0.1:" + address.port },
      { name: "CURSOR_API_KEY", value: "" },
    ]
    const first = scope(directory, "first"),
      second = scope(directory, "second"),
      settings = { environment, apiKey: "fixture" }
    expect(await driver.detect({ environment }, second)).toMatchObject({
      installed: true,
      authenticated: false,
    })
    expect(await driver.detect(settings, first)).toMatchObject({
      installed: true,
      authenticated: true,
      email: "demo@example.test",
    })
    expect(await driver.listModels(settings, first)).toMatchObject([
      { id: "available", displayName: "SDK model" },
    ])
    expect(await driver.listModels({ environment }, second)).toEqual([])
    expect(received).toEqual(expect.arrayContaining(["/v1/me", "/v1/models"]))
  } finally {
    await driver.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

it("loads the published ES module as a worker and runs native Cursor login, model controls, resume and cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-cursor-worker-"))
  const log = join(directory, "operations.jsonl"),
    authorize = join(directory, "authorized")
  const sdk = join(directory, "node_modules", "@cursor", "sdk"),
    bundle = join(directory, "index.mjs")
  let driver: CursorDriver | undefined
  try {
    await mkdir(join(sdk, "dist", "cjs"), { recursive: true })
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({ name: "@cursor/sdk", version: "1.3.1", main: "dist/cjs/index.mjs" }),
    )
    await build({
      entryPoints: [fileURLToPath(new URL("../test-fixtures/sdk.ts", import.meta.url))],
      outfile: join(sdk, "dist", "cjs", "index.mjs"),
      platform: "node",
      format: "esm",
    })
    await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      external: ["@cursor/sdk"],
      define: { __PIGCODE_VERSION__: '"test"' },
    })
    const plugin = await import(/* @vite-ignore */ pathToFileURL(bundle).href)
    let loaded: CursorDriver | undefined
    plugin.apply({
      agents: {
        register: (value: CursorDriver) => {
          loaded = value
        },
      },
      effect: () => {},
    })
    if (!loaded) throw new Error("plugin failed to register")
    const agent = loaded
    driver = agent
    const settings = {
      environment: [
        { name: "CURSOR_API_KEY", value: "" },
        { name: "CURSOR_TEST_LOG", value: log },
        { name: "CURSOR_TEST_LOGIN", value: authorize },
      ],
    }
    const first = scope(directory, "first"),
      second = scope(directory, "second")
    const auth = (action: Parameters<typeof agent.accountSetup.auth>[0]) =>
      agent.accountSetup.auth(action, settings, first)
    const initial = await auth({ action: "start" })
    expect(initial.flowId).toBeTruthy()
    await expect
      .poll(() => auth({ action: "status" }))
      .toMatchObject({ phase: "waiting", authorizationUrl: "https://cursor.example.test/auth" })
    expect(await auth({ action: "cancel", flowId: initial.flowId! })).toMatchObject({
      phase: "cancelled",
    })
    expect(await agent.detect(settings, first)).toMatchObject({ authenticated: false })
    await auth({ action: "start" })
    await writeFile(authorize, "accepted")
    await expect.poll(() => auth({ action: "status" })).toMatchObject({ phase: "connected" })
    expect(await agent.detect(settings, second)).toMatchObject({ authenticated: false })
    expect(await agent.listModels(settings, first)).toMatchObject([
      { id: "model", fast: true, efforts: ["high"], defaultEffort: "high" },
    ])
    const mcp = {
      tools: [],
      callTool: async () => null,
      stdioServer: () => ({ command: "node", args: ["tools.js"], env: {} }),
    }
    const input = {
      threadId: "thread",
      cwd: directory,
      model: "model",
      permissionMode: "full-access",
      planMode: true,
      instance: first,
      settings,
      mcp,
    }
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "unknown"]) {
      await expect(agent.createSession({ ...input, permissionMode: mode })).rejects.toThrow(
        "does not support",
      )
    }
    expect(agent.executionModes).toEqual({ plan: true, permissions: ["full-access"] })
    const handle = await agent.createSession(input)
    const events: AgentEvent[] = []
    await agent.send(
      handle,
      { text: "test", effort: "high", fast: true },
      {
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        requestApproval: async () => "deny",
      },
    )
    expect(events).toContainEqual({ type: "message.delta", text: "response" })
    expect(events).toContainEqual({ type: "reasoning.completed", text: "thinking" })
    expect(events).toContainEqual({ type: "message.completed", text: "response" })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "tool",
      name: "read",
      output: { text: "x" },
      isError: false,
    })
    const restored = await agent.createSession({
      ...input,
      sessionId: handle.id,
      nativeSessionId: handle.nativeSessionId,
      planMode: false,
    })
    expect(restored.nativeSessionId).toBe(handle.nativeSessionId)
    const sending = agent.send(
      restored,
      { text: "hold" },
      { signal: new AbortController().signal, emit: () => {}, requestApproval: async () => "deny" },
    )
    const operations = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    await expect
      .poll(async () => (await operations()).filter((op) => op.op === "send"))
      .toHaveLength(2)
    await agent.interrupt(restored)
    await sending
    expect(await operations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "create",
          mode: "plan",
          autoReview: false,
          sandbox: process.platform !== "win32",
          mcp: null,
          tools: ["read", "grep", "glob", "ls"],
          sources: [],
        }),
        expect.objectContaining({
          op: "send",
          text: "test",
          model: {
            id: "model",
            params: [
              { id: "effort", value: "high" },
              { id: "fast", value: "true" },
            ],
          },
        }),
        expect.objectContaining({
          op: "resume",
          mode: "agent",
          sandbox: false,
          autoReview: false,
          tools: null,
          mcp: { pigcode: { type: "stdio", ...mcp.stdioServer() } },
        }),
        { op: "cancel" },
      ]),
    )
    expect(await auth({ action: "logout" })).toMatchObject({ phase: "signed-out" })
    expect(await agent.detect(settings, first)).toMatchObject({ authenticated: false })
  } finally {
    await driver?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)

it.each(["darwin", "linux", "win32"] as const)(
  "enforces the read-only Cursor plan allowlist on %s",
  (platform) => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"]) {
      expect(() => cursorPolicy(mode, false, platform)).toThrow("does not support")
    }
    const plan = cursorPolicy("full-access", true, platform)
    expect(plan.native).toEqual({ mode: "plan", tools: ["read", "grep", "glob", "ls"] })
    expect(plan.local).toEqual({
      autoReview: false,
      sandboxOptions: { enabled: platform !== "win32" },
      settingSources: [],
    })
  },
)

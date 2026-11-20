import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import { OpenCodeDriver } from "./driver"

// Explicit opt-in lets CI run this against an installed OpenCode 2.x executable.
it.skipIf(!process.env.PIGCODE_TEST_OPENCODE_BINARY)(
  "runs the installed OpenCode server against a local inference endpoint",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pigcode-opencode-real-"))
    const driver = new OpenCodeDriver()
    const calls: string[] = []
    const endpoint = createServer(async (req, res) => {
      let body = ""
      for await (const part of req) body += part
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end()
        return
      }
      const request = JSON.parse(body)
      calls.push(request.model)
      const packet = {
        id: "chatcmpl-test",
        model: request.model,
        created: 42,
        object: "chat.completion.chunk",
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const choice of [
        { index: 0, delta: { role: "assistant", content: "local answer" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]) {
        res.write("data: " + JSON.stringify({ ...packet, choices: [choice] }) + "\n\n")
      }
      res.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
    try {
      const address = endpoint.address()
      if (!address || typeof address === "string") throw new Error("No inference endpoint")
      const cwd = join(directory, "work"),
        config = join(directory, "opencode.json")
      await mkdir(cwd)
      await writeFile(
        config,
        JSON.stringify({
          model: "fixture/local-model",
          providers: {
            fixture: {
              name: "Local fixture",
              env: ["PIGCODE_TEST_MODEL_KEY"],
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "http://127.0.0.1:" + address.port + "/v1" },
              models: { "local-model": { name: "Local fixture model" } },
            },
          },
        }),
      )
      const environment = Object.entries({
        OPENCODE_CONFIG: config,
        OPENCODE_CONFIG_DIR: join(directory, "config", "opencode"),
        PIGCODE_TEST_MODEL_KEY: "fixture",
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
        XDG_STATE_HOME: join(directory, "state"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        HTTP_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "localhost,127.0.0.1",
        https_proxy: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        no_proxy: "localhost,127.0.0.1",
      }).map(([name, value]) => ({ name, value }))
      const settings = { binaryPath: process.env.PIGCODE_TEST_OPENCODE_BINARY!, environment }
      const instance = {
        instanceId: "local-test",
        dataDir: join(directory, "instance"),
        sharedDir: directory,
        invalidate() {},
      }
      expect(await driver.detect(settings, instance)).toMatchObject({
        installed: true,
        version: expect.stringMatching(/^2\./),
      })
      expect(await driver.listModels(settings, instance)).toContainEqual(
        expect.objectContaining({ id: "fixture/local-model" }),
      )
      const input = {
        threadId: "local",
        cwd,
        instance,
        settings,
        model: "fixture/local-model",
        permissionMode: "approval-required",
      }
      const first = await driver.createSession(input)
      const events: AgentEvent[] = []
      const signal = AbortSignal.timeout(18_000)
      await driver.send(
        first,
        { text: "Reply locally." },
        { emit: (event) => events.push(event), signal, requestApproval: async () => "deny" },
      )
      expect(calls).toContain("local-model")
      expect(events).toContainEqual({ type: "message.completed", text: "local answer" })
      const restored = await driver.createSession({
        ...input,
        sessionId: first.id,
        nativeSessionId: first.nativeSessionId,
      })
      expect(restored.nativeSessionId).toBe(first.nativeSessionId)
      await driver.dispose(restored)
    } finally {
      await driver.close()
      endpoint.closeAllConnections()
      await new Promise<void>((resolve) => endpoint.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
  35_000,
)

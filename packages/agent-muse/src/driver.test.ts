import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import { MuseDriver } from "./driver"

it("runs Muse's native MSP client against the configured executable, including approvals, questions, resume and cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-muse-test-"))
  const driver = new MuseDriver()
  try {
    const fixture = join(directory, "muse.mjs"),
      log = join(directory, "operations.jsonl")
    await build({
      entryPoints: [fileURLToPath(new URL("../test-fixtures/muse.ts", import.meta.url))],
      outfile: fixture,
      platform: "node",
      format: "esm",
    })
    await chmod(fixture, 0o755)
    const binaryPath = process.platform === "win32" ? join(directory, "muse.cmd") : fixture
    if (process.platform === "win32")
      await writeFile(binaryPath, '@SETLOCAL\r\nnode "%~dp0muse.mjs" %*\r\n')
    const settings = { binaryPath, environment: [{ name: "MUSE_TEST_LOG", value: log }] }
    const operations = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    expect(await driver.detect(settings)).toMatchObject({
      installed: true,
      version: "1.4.6",
      authenticated: null,
    })
    expect(await driver.listModels(settings)).toMatchObject([
      { id: "test-model", displayName: "Test Muse", isDefault: true, efforts: ["low", "high"] },
    ])
    const mcp = {
      tools: [],
      callTool: async () => null,
      stdioServer: () => ({ command: "node", args: ["mcp.js"], env: {} }),
    }
    const input = {
      threadId: "thread",
      cwd: directory,
      model: "test-model",
      permissionMode: "approval-required",
      settings,
      mcp,
    }
    await expect(
      driver.createSession({ ...input, permissionMode: "auto-accept-edits" }),
    ).rejects.toThrow("does not support")
    const handle = await driver.createSession(input)
    const events: AgentEvent[] = []
    await driver.send(
      handle,
      { text: "hello", effort: "high" },
      {
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
        requestApproval: async (request) => {
          expect(request.toolName).toBe("shell")
          return "allow-once"
        },
        askQuestions: async (request) => {
          expect(request.questions[0]?.multiSelect).toBe(true)
          return ["Alpha, Beta"]
        },
      },
    )
    expect(events).toContainEqual({ type: "message.delta", text: "confirmed" })
    expect(events).toContainEqual({ type: "message.completed", text: "confirmed" })
    expect(events).not.toContainEqual({ type: "message.delta", text: "foreign" })
    expect(await operations()).toEqual(
      expect.arrayContaining([
        { args: ["serve", "--disable-shell", "--disable-write", "--no-session-log"] },
        expect.objectContaining({
          method: "session/start",
          params: expect.objectContaining({
            modelId: "test-model",
            permissionProfile: ":ask-me",
            config: {
              mcpServers: {
                pigcode: { transport: "stdio", mode: "optional", ...mcp.stdioServer() },
              },
            },
          }),
        }),
        expect.objectContaining({
          method: "approval/decide",
          params: expect.objectContaining({ choiceId: "once" }),
        }),
        expect.objectContaining({
          method: "userInput/answer",
          params: expect.objectContaining({
            answers: [{ questionId: "features", selectedLabels: ["Alpha", "Beta"] }],
          }),
        }),
      ]),
    )
    const restored = await driver.createSession({
      ...input,
      sessionId: handle.id,
      nativeSessionId: handle.nativeSessionId,
    })
    expect(restored.nativeSessionId).toBe(handle.nativeSessionId)
    const sending = driver.send(
      restored,
      { text: "hold" },
      { signal: new AbortController().signal, emit: () => {}, requestApproval: async () => "deny" },
    )
    await expect
      .poll(async () => (await operations()).filter((op) => op.method === "turn/start"))
      .toHaveLength(2)
    await driver.interrupt(restored)
    await sending
    expect((await operations()).some((op) => op.method === "turn/interrupt")).toBe(true)
    await expect(
      driver.createSession({
        ...input,
        nativeSessionId: handle.nativeSessionId,
        settings: {
          ...settings,
          environment: [...settings.environment, { name: "MUSE_TEST_BAD_MODE", value: "allowAll" }],
        },
      }),
    ).rejects.toThrow("did not confirm")
    await expect(driver.createSession({ ...input, nativeSessionId: "absent" })).rejects.toThrow(
      "no longer exists",
    )
  } finally {
    await driver.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

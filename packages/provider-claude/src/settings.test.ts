/** 验证设置页的值如何作用到 Claude Code：可执行文件、CLAUDE_CONFIG_DIR、环境变量与启动参数。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { describe, expect, it, vi } from "vitest"
import { ClaudeDriver } from "./driver"
import { apply } from "./index"
import { claudeLaunch } from "./launch"
import { claudeMcpServer } from "./mcp"
import { replayQuery } from "./replay"

const runtime = {
  signal: new AbortController().signal,
  emit: () => undefined,
  requestApproval: async () => "allow-once" as const,
}

describe("Claude launch settings", () => {
  it("leaves the environment alone when nothing is configured", () => {
    const launch = claudeLaunch({}, "/fixed/claude")
    expect(launch).toEqual({ executable: "/fixed/claude", env: undefined, extraArgs: {} })
  })

  it("expands CLAUDE_CONFIG_DIR, adds environment entries and drops managed flags", () => {
    const launch = claudeLaunch(
      {
        binaryPath: "~/bin/claude",
        configDir: "~/.claude-work",
        environment: [{ name: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }],
        launchArgs:
          "--chrome --permission-mode bypassPermissions --add-dir /tmp/extra --model opus",
      },
      undefined,
    )
    expect(launch.executable).toBe(join(homedir(), "bin/claude"))
    expect(launch.env?.CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude-work"))
    expect(launch.env?.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
    expect(launch.env?.PATH).toBe(process.env.PATH)
    expect(launch.extraArgs).toEqual({ chrome: null, "add-dir": "/tmp/extra" })
  })

  it("passes executable, environment and extra args to every query", async () => {
    const captured: Options[] = []
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured.push(params.options)
        return replay(params)
      },
    })
    const session = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      settings: {
        binaryPath: "/opt/claude/bin/claude",
        configDir: "/tmp/claude-config",
        launchArgs: "--chrome",
      },
    })
    await driver.send(session, { text: "hello" }, runtime)
    expect(captured[0]).toMatchObject({
      pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
      extraArgs: { chrome: null },
    })
    expect(captured[0]?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-config")

    // 下一个 run 的会话带着新设置：改设置不需要重启。
    const next = await driver.createSession({ threadId: "t1", cwd: "/tmp", sessionId: session.id })
    await driver.send(next, { text: "again" }, runtime)
    expect(captured[1]).not.toHaveProperty("extraArgs")
    expect(captured[1]).not.toHaveProperty("env")
  })
})

describe("Claude detection", () => {
  // fixture 是 /bin/sh 脚本，Windows 上不能直接执行。
  it.skipIf(process.platform === "win32")(
    "probes the configured binary with the configured environment",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pigcode-claude-settings-"))
      const bin = join(dir, "claude-custom")
      await writeFile(
        bin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then
  if [ "$CLAUDE_CONFIG_DIR" = "${dir}/cfg" ]; then
    echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
  else
    echo '{"loggedIn":false}'
  fi
  exit 0
fi
exit 1
`,
      )
      await chmod(bin, 0o755)
      const driver = new ClaudeDriver()
      await expect(
        driver.detect({ binaryPath: bin, configDir: join(dir, "cfg") }),
      ).resolves.toEqual({
        installed: true,
        version: "9.9.9 (Claude Code)",
        authenticated: true,
        account: "max · claude.ai",
        command: bin,
        error: null,
      })
      await expect(driver.detect({ binaryPath: bin })).resolves.toMatchObject({
        installed: true,
        authenticated: false,
      })
      await expect(driver.detect({ binaryPath: join(dir, "missing") })).resolves.toMatchObject({
        installed: false,
        authenticated: null,
        error: expect.stringContaining("not found"),
      })
    },
  )
})

describe("Claude MCP server", () => {
  it("builds an in-process server that calls back into the session", async () => {
    const callTool = vi.fn(async () => ({ ok: true }))
    expect(
      claudeMcpServer({
        tools: [],
        callTool,
        stdioServer: () => ({ command: "", args: [], env: {} }),
      }),
    ).toBeNull()
    const server = claudeMcpServer({
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
      ],
      callTool,
      stdioServer: () => ({ command: "", args: [], env: {} }),
    })
    expect(server).toMatchObject({ type: "sdk", name: "pigcode" })
    expect(server?.instance).toBeTruthy()
  })
})

describe("Claude plugin entry", () => {
  it("registers the driver and cleans up on unload", () => {
    const registered: string[] = []
    const effects: Array<() => void> = []
    const context: Pick<PluginHostContext, "providers" | "effect"> = {
      providers: {
        register: (driver) => void registered.push(driver.id),
        unregister: (id) => void registered.splice(registered.indexOf(id), 1),
      },
      effect: (setup) => {
        const cleanup = setup()
        if (cleanup) effects.push(cleanup)
      },
    }
    apply(context as PluginHostContext)
    expect(registered).toEqual(["claude"])
    for (const cleanup of effects) cleanup()
    expect(registered).toEqual([])
  })
})

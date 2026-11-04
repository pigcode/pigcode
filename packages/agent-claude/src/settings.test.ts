/** 验证设置页的值如何作用到 Claude Code：可执行文件、CLAUDE_CONFIG_DIR、环境变量与启动参数。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { describe, expect, it, vi } from "vitest"
import { ClaudeDriver } from "./driver"
import { apply } from "./index"
import { claudeLaunch, sdkExecutable } from "./launch"
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

describe("Claude SDK executable", () => {
  // npm 在 Windows 上把 claude 装成 .cmd shim；SDK 只能直接启动它背后的文件。
  it.runIf(process.platform === "win32")("unwraps an npm shim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-claude-sdk-"))
    const bin = join(dir, "bin")
    await mkdir(bin, { recursive: true })
    const exe = join(bin, "claude.exe")
    await writeFile(exe, "")
    const shim = join(dir, "claude.cmd")
    await writeFile(
      shim,
      ["@ECHO off", "SET dp0=%~dp0", '"%dp0%\\bin\\claude.exe"   %*'].join("\r\n"),
    )

    expect(sdkExecutable(shim)).toBe(exe)
    // 已经是可执行文件、或解析不出来时保持原样。
    expect(sdkExecutable("/opt/claude/bin/claude")).toBe("/opt/claude/bin/claude")
    expect(sdkExecutable(undefined)).toBeUndefined()
  })
})

describe("Claude detection", () => {
  /**
   * 写一个假的 CLI：Windows 上写成 npm 装出来的 .cmd shim（检测必须经 shell 启动它），
   * 其他平台写成 /bin/sh 脚本。
   */
  async function writeCli(dir: string, name: string, unix: string, windows: string[]) {
    const onWindows = process.platform === "win32"
    const path = join(dir, onWindows ? `${name}.cmd` : name)
    await writeFile(path, onWindows ? `${windows.join("\r\n")}\r\n` : unix)
    if (!onWindows) await chmod(path, 0o755)
    return path
  }

  it("probes the configured binary with the configured environment", async () => {
    // 目录带空格：Windows 上退回 shell 时路径必须自己加引号，否则 cmd 会在空格处断开。
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-claude-settings-")), "space dir")
    await mkdir(dir, { recursive: true })
    const configDir = join(dir, "cfg")
    const bin = await writeCli(
      dir,
      "claude-custom",
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then
  if [ "$CLAUDE_CONFIG_DIR" = "${configDir}" ]; then
    echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
  else
    echo '{"loggedIn":false}'
  fi
  exit 0
fi
exit 1
`,
      [
        "@echo off",
        'if "%1"=="--version" echo 9.9.9 (Claude Code)',
        'if "%1"=="--version" exit /b 0',
        'if not "%1"=="auth" exit /b 1',
        `if "%CLAUDE_CONFIG_DIR%"=="${configDir}" (`,
        '  echo {"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}',
        ") else (",
        '  echo {"loggedIn":false}',
        ")",
        "exit /b 0",
      ],
    )
    const driver = new ClaudeDriver()
    await expect(driver.detect({ binaryPath: bin, configDir })).resolves.toEqual({
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
  })
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
    const context: Pick<PluginHostContext, "agents" | "effect"> = {
      agents: {
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

/** 验证设置页的值如何作用到 Codex：可执行文件、CODEX_HOME、启动参数，以及设置变化后不复用旧进程。 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CodexDriver } from "./driver"
import { codexLaunch, launchKey, type CodexLaunch } from "./launch"
import { ScriptedTransport, messageOf } from "./scripted-transport"

describe("Codex launch settings", () => {
  it("defaults to codex app-server with the inherited environment", () => {
    const launch = codexLaunch({})
    expect(launch.args).toEqual(["app-server", "--stdio"])
    expect(launch.env).toBeUndefined()
  })

  it("applies binary path, CODEX_HOME, environment and launch args", () => {
    const launch = codexLaunch({
      binaryPath: "~/tools/codex",
      homePath: "~/.codex-work",
      environment: [{ name: "OPENAI_BASE_URL", value: "http://127.0.0.1:8080/v1" }],
      launchArgs: `-c model_reasoning_summary=detailed -c 'sandbox_workspace_write.network_access=true'`,
    })
    expect(launch.command).toBe(join(homedir(), "tools/codex"))
    expect(launch.args).toEqual([
      "app-server",
      "--stdio",
      "-c",
      "model_reasoning_summary=detailed",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ])
    expect(launch.env?.CODEX_HOME).toBe(join(homedir(), ".codex-work"))
    expect(launch.env?.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1")
  })

  it("changes the launch key only when the effective command changes", () => {
    expect(launchKey(codexLaunch({}))).toBe(launchKey(codexLaunch({ launchArgs: "  " })))
    expect(launchKey(codexLaunch({}))).not.toBe(launchKey(codexLaunch({ homePath: "/tmp/h" })))
  })
})

describe("Codex driver with settings", () => {
  it("spawns app-server with the configured command and restarts it after settings change", async () => {
    const launches: CodexLaunch[] = []
    const driver = new CodexDriver({
      transportFactory: (launch) => {
        launches.push(launch)
        return new ScriptedTransport({ nativeThreadId: "th_native" })
      },
    })
    const settings = { binaryPath: "/opt/codex", homePath: "/tmp/codex-home" }
    const first = await driver.createSession({ threadId: "t1", cwd: "/tmp", settings })
    expect(launches[0]).toMatchObject({ command: "/opt/codex" })
    expect(launches[0]?.env?.CODEX_HOME).toBe("/tmp/codex-home")

    // 设置没变：同一原生 thread 复用空闲的 app-server。
    await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      nativeSessionId: first.nativeSessionId,
      settings,
    })
    expect(launches).toHaveLength(1)

    // 改了 CODEX_HOME：下一次 run 按新设置启动新的 app-server 并恢复原生 thread。
    const transports: ScriptedTransport[] = []
    const tracked = new CodexDriver({
      transportFactory: (launch) => {
        launches.push(launch)
        const transport = new ScriptedTransport({ nativeThreadId: "th_native" })
        transports.push(transport)
        return transport
      },
    })
    const base = await tracked.createSession({ threadId: "t2", cwd: "/tmp", settings })
    await tracked.createSession({
      threadId: "t2",
      cwd: "/tmp",
      nativeSessionId: base.nativeSessionId,
      settings: { ...settings, homePath: "/tmp/other-home" },
    })
    expect(launches).toHaveLength(3)
    expect(launches[2]?.env?.CODEX_HOME).toBe("/tmp/other-home")
    expect(messageOf(transports[1]!, "thread/resume")?.params).toMatchObject({
      threadId: "th_native",
    })
    driver.close()
    tracked.close()
  })

  // fixture 是 /bin/sh 脚本，Windows 上不能直接执行。
  it.skipIf(process.platform === "win32")(
    "detects the configured binary with CODEX_HOME",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pigcode-codex-settings-"))
      const bin = join(dir, "codex-custom")
      await writeFile(
        bin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.0.0"; exit 0; fi
if [ "$1" = "login" ]; then
  if [ "$CODEX_HOME" = "${dir}/home" ]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
exit 1
`,
      )
      await chmod(bin, 0o755)
      const driver = new CodexDriver()
      await expect(
        driver.detect({ binaryPath: bin, homePath: join(dir, "home") }),
      ).resolves.toEqual({
        installed: true,
        version: "codex-cli 9.0.0",
        authenticated: true,
        account: "Logged in using ChatGPT",
        command: bin,
        error: null,
      })
      await expect(driver.detect({ binaryPath: bin })).resolves.toMatchObject({
        authenticated: false,
        error: null,
      })
    },
  )
})

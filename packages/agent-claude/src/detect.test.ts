/** 用 fixture 脚本验证检测解析，不依赖真实账号。 */
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectClaude } from "./detect"

/**
 * 写一个假的 CLI：Windows 上写成 npm 装出来的 .cmd shim（检测必须经 shell 启动它），
 * 其他平台写成 /bin/sh 脚本。
 */
async function writeCli(
  dir: string,
  name: string,
  unix: string,
  windows: string[],
): Promise<string> {
  const windowsPath = process.platform === "win32"
  const path = join(dir, windowsPath ? `${name}.cmd` : name)
  await writeFile(path, windowsPath ? `${windows.join("\r\n")}\r\n` : unix)
  if (!windowsPath) await chmod(path, 0o755)
  return path
}

describe("detectClaude", () => {
  it("parses version and auth status", async () => {
    // 目录带空格：Windows 上退回 shell 时路径必须自己加引号，否则 cmd 会在空格处断开。
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-claude-")), "space dir")
    await mkdir(dir, { recursive: true })
    const bin = await writeCli(
      dir,
      "claude",
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.304 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'; exit 0
fi
exit 1
`,
      [
        "@echo off",
        'if "%1"=="--version" echo 2.1.304 (Claude Code)',
        'if "%1"=="--version" exit /b 0',
        'if "%1"=="auth" echo {"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}',
        'if "%1"=="auth" exit /b 0',
        "exit /b 1",
      ],
    )
    const result = await detectClaude({ command: bin })
    expect(result.installed).toBe(true)
    expect(result.version).toContain("2.1.304")
    expect(result.loggedIn).toBe(true)
    expect(result.subscriptionType).toBe("pro")
  })

  // cmd-shim 生成的 shim 解包后要真的能启动目标，不只是返回一个路径。
  it.runIf(process.platform === "win32")("runs the target behind a generated shim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-claude-shim-"))
    // 用 node 自己冒充原生 CLI：--version 会打印版本号，足够验证解包后的启动路径。
    const exe = join(dir, "claude.exe")
    await copyFile(process.execPath, exe)
    const shim = join(dir, "claude.cmd")
    await writeFile(shim, ["@ECHO off", "SET dp0=%~dp0", '"%dp0%\\claude.exe" %*'].join("\r\n"))

    const result = await detectClaude({ command: shim })
    expect(result.installed).toBe(true)
    expect(result.version).toContain(process.versions.node)
  })
})

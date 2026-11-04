/** 用 fixture 脚本验证 Codex 检测，不依赖真实账号。 */
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectCodex } from "./detect"

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
  const onWindows = process.platform === "win32"
  const path = join(dir, onWindows ? `${name}.cmd` : name)
  await writeFile(path, onWindows ? `${windows.join("\r\n")}\r\n` : unix)
  if (!onWindows) await chmod(path, 0o755)
  return path
}

describe("detectCodex", () => {
  it("parses version and login status", async () => {
    // 目录带空格：Windows 上退回 shell 时路径必须自己加引号，否则 cmd 会在空格处断开。
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-codex-")), "space dir")
    await mkdir(dir, { recursive: true })
    const bin = await writeCli(
      dir,
      "codex",
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 1
`,
      [
        "@echo off",
        'if "%1"=="--version" echo codex-cli 0.163.0',
        'if "%1"=="--version" exit /b 0',
        'if "%1"=="login" echo Logged in using ChatGPT',
        'if "%1"=="login" exit /b 0',
        "exit /b 1",
      ],
    )
    const result = await detectCodex({ command: bin })
    expect(result.installed).toBe(true)
    expect(result.version).toContain("0.163.0")
    expect(result.loggedIn).toBe(true)
  })
})

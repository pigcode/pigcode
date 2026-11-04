/** 验证 Windows 上 npm 装的 .cmd 形式的 codex 能启动并收到它的输出。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { StdioCodexTransport } from "./transport"

describe("StdioCodexTransport", () => {
  // npm 在 Windows 上把 codex 装成 .cmd；不经过 shell 启动会报 EINVAL。
  it.runIf(process.platform === "win32")("starts a .cmd codex through the shell", async () => {
    // 目录带空格：退回 shell 时路径必须自己加引号，否则 cmd 会在空格处断开。
    const dir = join(await mkdtemp(join(tmpdir(), "pigcode-codex-cmd-")), "space dir")
    await mkdir(dir, { recursive: true })
    const bin = join(dir, "codex.cmd")
    await writeFile(
      bin,
      ["@echo off", 'echo {"jsonrpc":"2.0","id":1,"result":{"ok":true}}', "exit /b 0"].join("\r\n"),
    )
    const transport = new StdioCodexTransport(bin, ["app-server", "--stdio"])
    const line = await new Promise<string>((resolve, reject) => {
      transport.onClose?.(reject)
      transport.onLine(resolve)
    })
    expect(line).toContain('"ok":true')
    transport.close()
  })
})

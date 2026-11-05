/** 验证 Windows 上 npm 装的 .cmd 形式的 codex 能启动，以及关闭时不留下子进程。 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
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

  it("ends the app-server and whatever it started when it closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-codex-tree-"))
    const bin = join(dir, "fake-codex.js")
    await writeFile(
      bin,
      `const { spawn } = require("node:child_process")
       const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
       setTimeout(() => console.log(JSON.stringify({ tool: tool.pid })), 200)
       setInterval(() => {}, 1000)`,
    )
    const transport = new StdioCodexTransport(process.execPath, [bin])
    const line = await new Promise<string>((resolve) => transport.onLine(resolve))
    const toolPid = (JSON.parse(line) as { tool: number }).tool
    await transport.close()
    const gone = () => {
      try {
        process.kill(toolPid, 0)
        return false
      } catch {
        return true
      }
    }
    await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 5000, interval: 25 })
  })
})

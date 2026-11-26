import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  assertSingleNoiseFrame,
  createFakePtyFactory,
  setupTerminalHost,
} from "./terminal.test-helpers"

describe("mobile terminal Dart client end-to-end", { timeout: 30_000 }, () => {
  it("runs real Node Host <-> Dart pigcode_client terminal end-to-end loopback within single Noise frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mterm-dart-e2e-"))
    const fake = createFakePtyFactory()
    const host = await setupTerminalHost(fake.factory)

    const project = host.ctx.projects.add(root, "Dart 终端联调")
    const thread = host.ctx.threads.create(project.id, "终端联调会话", "fake")
    const desktopTerm = await host.ctx.terminal.open({ threadId: thread.id }, 100, 32)
    fake.instances[0]!.emit("desktop-banner\r\n")

    const phone = host.connectDevice("Dart 终端手机", 88, ["terminal"])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/terminal_e2e_driver.dart"], {
      cwd: clientPkgDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    dart.stdin.on("error", () => {})
    let stderr = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    // 将 Host 发给 phone.wire.client 的所有响应与推送通知实时桥接给 Dart 进程
    phone.wire.client.onMessage((message) => {
      assertSingleNoiseFrame(message)
      if (!dart.killed) {
        dart.stdin.write(`${JSON.stringify({ dir: "rpc_msg", message })}\n`)
      }
    })

    const cmdPending = new Map<
      string,
      (res: { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string }) => void
    >()
    const rl = createInterface({ input: dart.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      const msg = JSON.parse(line) as {
        dir: string
        id?: string
        method?: string
        params?: Record<string, unknown>
        cmdId?: string
        ok?: boolean
        data?: Record<string, unknown>
        code?: string
        error?: string
      }
      if (msg.dir === "rpc_req") {
        const req = { jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params ?? {} }
        assertSingleNoiseFrame(req)
        phone.wire.client.send(req)
      } else if (msg.dir === "cmd_res" && msg.cmdId) {
        const resolve = cmdPending.get(msg.cmdId)
        if (resolve) {
          cmdPending.delete(msg.cmdId)
          resolve({
            ok: msg.ok === true,
            ...(msg.data ? { data: msg.data } : {}),
            ...(msg.code ? { code: msg.code } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          })
        }
      }
    })

    function runDart(action: string, args: Record<string, unknown> = {}) {
      const cmdId = randomUUID()
      return new Promise<{
        ok: boolean
        data?: Record<string, unknown>
        code?: string
        error?: string
      }>((resolve) => {
        cmdPending.set(cmdId, resolve)
        dart.stdin.write(`${JSON.stringify({ dir: "cmd", cmdId, action, args })}\n`)
      })
    }

    try {
      // 1. 列出电脑终端并尝试越权写 → TERMINAL_READ_ONLY
      const listed = await runDart("list", { threadId: thread.id })
      expect(listed.ok, stderr).toBe(true)
      expect((listed.data!.terminals as Array<{ id: string; writable: boolean }>)[0]).toMatchObject(
        {
          id: desktopTerm.id,
          writable: false,
        },
      )

      const writeDesktop = await runDart("write", { terminalId: desktopTerm.id, data: "whoami\n" })
      expect(writeDesktop.ok).toBe(false)
      expect(writeDesktop.code).toBe("TERMINAL_READ_ONLY")

      // 2. 新建手机终端 → 写入输入 → 接收实时输出与分片回放 → 调尺寸 → 关闭
      const openedRes = await runDart("open", { threadId: thread.id, cols: 48, rows: 24 })
      expect(openedRes.ok, stderr).toBe(true)
      const mobileTerm = openedRes.data!.terminal as { id: string; writable: boolean }
      expect(mobileTerm.writable).toBe(true)
      const mobilePty = fake.instances[1]!

      const writeRes = await runDart("write", { terminalId: mobileTerm.id, data: "echo 你好🚀\r" })
      expect(writeRes.ok, stderr).toBe(true)
      expect(mobilePty.writes).toEqual(["echo 你好🚀\r"])

      mobilePty.emit("你好🚀\r\n")
      const events1 = await runDart("drainEvents")
      const outs1 = events1.data!.outputs as Array<{ data: string; cursor: number }>
      expect(outs1.map((o) => o.data).join("")).toBe("你好🚀\r\n")
      const cursor1 = outs1[outs1.length - 1]!.cursor

      // 模拟断线后大量输出并带游标重附着
      await runDart("detach", { terminalId: mobileTerm.id })
      const chunked = "\x1b[36m回放块\x1b[0m-0123456789\r\n".repeat(1200)
      mobilePty.emit(chunked)

      const attachRes = await runDart("attach", {
        threadId: thread.id,
        terminalId: mobileTerm.id,
        afterCursor: cursor1,
        cols: 60,
        rows: 26,
      })
      expect(attachRes.ok, stderr).toBe(true)
      expect(attachRes.data!.replayChunks as number).toBeGreaterThanOrEqual(2)
      const events2 = await runDart("drainEvents")
      const replayed = (events2.data!.outputs as Array<{ data: string }>)
        .map((o) => o.data)
        .join("")
      expect(replayed).toBe(chunked)

      const resized = await runDart("resize", { terminalId: mobileTerm.id, cols: 72, rows: 30 })
      expect(resized.ok, stderr).toBe(true)
      expect(resized.data).toEqual({ cols: 72, rows: 30 })

      const closed = await runDart("close", { terminalId: mobileTerm.id })
      expect(closed.ok, stderr).toBe(true)
      expect(mobilePty.killed).toBe(true)
    } finally {
      dart.stdin.write(`${JSON.stringify({ dir: "shutdown" })}\n`)
      dart.stdin.end()
      await new Promise<void>((resolve) => {
        dart.once("exit", () => resolve())
        setTimeout(() => {
          dart.kill("SIGKILL")
          resolve()
        }, 2000)
      })
      rl.close()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

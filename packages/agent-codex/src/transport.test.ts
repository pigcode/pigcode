/**
 * Codex app-server 的 stdio 传输：stderr 必须持续读掉。
 * app-server 是原生程序，stderr 写满没人读的管道后会停在 write 上，
 * 之后一个通知都发不出来（#83）。
 */
import { describe, expect, it } from "vitest"
import { StdioCodexTransport } from "./transport"

describe("StdioCodexTransport", () => {
  it("keeps reading stderr so a chatty app-server keeps answering", async () => {
    // fs.writeSync(2) 和 Rust 的 eprintln! 一样是阻塞写：管道没人读、写满约 64KB 后，
    // 进程会停在 write 上，永远走不到下一行 stdout。
    const script =
      'require("node:fs").writeSync(2, "x".repeat(300000)); require("node:fs").writeSync(1, "{\\"ok\\":true}\\n")'
    const transport = new StdioCodexTransport(process.execPath, ["-e", script])
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stdout never arrived")), 5000)
        const dispose = transport.onLine((value) => {
          clearTimeout(timer)
          dispose()
          resolve(value)
        })
      })
      expect(JSON.parse(line)).toEqual({ ok: true })
    } finally {
      await transport.close()
    }
  })
})

/** 验证 CodexDriver 的进程复用、临时目录查询清理与 dispose/close 生命周期。 */
import { describe, expect, it, vi } from "vitest"
import { CodexDriver } from "./driver"
import { ScriptedTransport } from "./scripted-transport"

describe("CodexDriver lifecycle", () => {
  it("closes the transport on dispose and is idempotent", async () => {
    const transport = new ScriptedTransport({ nativeThreadId: "th_native" })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })

    await driver.dispose(session)
    expect(transport.closed).toBe(true)

    await driver.dispose(session)
    expect(transport.closed).toBe(true)
  })

  it("reuses a live app-server for the same native thread", async () => {
    let created = 0
    const driver = new CodexDriver({
      transportFactory: () => {
        created += 1
        return new ScriptedTransport({ nativeThreadId: "th_native" })
      },
    })

    const first = await driver.createSession({ threadId: "t1", cwd: "/tmp", sessionId: "ps_1" })
    const second = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      sessionId: "ps_1",
      nativeSessionId: first.nativeSessionId,
    })

    expect(second.id).toBe("ps_1")
    expect(created).toBe(1)
    await driver.dispose(second)
  })

  it("lists models from the app server and closes the temporary transport", async () => {
    const transport = new ScriptedTransport({ nativeThreadId: "th_native" })
    const driver = new CodexDriver({ transportFactory: () => transport })

    const models = await driver.listModels()

    expect(models).toEqual([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true }])
    expect(transport.closed).toBe(true)
  })
})

describe("CodexDriver process lifetime", () => {
  /** close 要等外部放行才完成的传输，模拟进程还没结束；initialize 可以设置成永远没有回应。 */
  class SlowClosingTransport extends ScriptedTransport {
    readonly closeCalled = vi.fn()
    finishClosing = (): void => undefined
    override close(): Promise<void> {
      this.closeCalled()
      return new Promise((resolve) => {
        this.finishClosing = resolve
      })
    }
  }

  /** 让 Promise 回调都跑完。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  // 注销 driver 时注册表先 dispose 活跃会话，不等结果，接着插件才 await close；Host 紧接着就退出。
  it("close also waits for a dispose nobody awaited", async () => {
    const transport = new SlowClosingTransport({ nativeThreadId: "th_native" })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    void driver.dispose(session)
    let finished = false
    const closed = driver.close().then(() => {
      finished = true
    })
    await settle()
    expect(transport.closeCalled).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    transport.finishClosing()
    await closed
    expect(finished).toBe(true)
  })

  it("close ends an app-server whose session is still being created", async () => {
    const transport = new SlowClosingTransport({ nativeThreadId: "th_native" })
    vi.spyOn(transport, "send").mockImplementation(() => undefined)
    const driver = new CodexDriver({ transportFactory: () => transport })
    void driver.createSession({ threadId: "t1", cwd: "/tmp" }).catch(() => undefined)
    const closed = driver.close()
    await settle()
    expect(transport.closeCalled).toHaveBeenCalledOnce()
    transport.finishClosing()
    await closed
  })
})

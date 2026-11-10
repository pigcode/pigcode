/** 验证 Codex 账号应答的解析与 driver 检测里账号信息的取舍。 */
import { describe, expect, it } from "vitest"
import { parseCodexAccount } from "./account"
import { CodexDriver } from "./driver"
import { ScriptedTransport } from "./scripted-transport"
import type { CodexDetection } from "./detect"

/** account/read 返回错误的 app-server，例如旧版 CLI 不认识这个方法。 */
class FailingAccountTransport extends ScriptedTransport {
  override send(line: string): void {
    const message = JSON.parse(line) as { id?: number; method?: string }
    if (message.method === "account/read") {
      this.push({ id: message.id, error: { code: -32601, message: "method not found" } })
      return
    }
    super.send(line)
  }
}

describe("parseCodexAccount", () => {
  it("names the ChatGPT plan and keeps the email", () => {
    expect(
      parseCodexAccount({
        account: { type: "chatgpt", email: "dev@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ loggedIn: true, label: "ChatGPT Pro", email: "dev@example.com" })
  })

  it("labels API key and Bedrock logins without an email", () => {
    expect(parseCodexAccount({ account: { type: "apiKey" } })).toEqual({
      loggedIn: true,
      label: "OpenAI API Key",
      email: null,
    })
    expect(parseCodexAccount({ account: { type: "amazonBedrock" } }).label).toBe("Amazon Bedrock")
  })

  it("treats a missing account as signed out and an odd reply as unknown", () => {
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true }).loggedIn).toBe(false)
    expect(parseCodexAccount("nope").loggedIn).toBeNull()
  })
})

describe("CodexDriver.detect", () => {
  const installed: CodexDetection = {
    installed: true,
    command: "codex",
    version: "codex-cli 0.167.0",
    loggedIn: false,
    account: null,
    error: "login status failed",
  }

  it("shows the account that app-server reports", async () => {
    const driver = new CodexDriver({
      detect: async () => installed,
      transportFactory: () =>
        new ScriptedTransport({
          nativeThreadId: "th",
          account: { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" } },
        }),
    })
    await expect(driver.detect({})).resolves.toEqual({
      installed: true,
      version: "codex-cli 0.167.0",
      authenticated: true,
      account: "ChatGPT Plus",
      email: "dev@example.com",
      command: "codex",
      error: null,
    })
  })

  it("keeps the login status answer when app-server cannot be reached", async () => {
    const driver = new CodexDriver({
      detect: async () => ({ ...installed, loggedIn: true, account: "Logged in", error: null }),
      transportFactory: () => new FailingAccountTransport({ nativeThreadId: "th" }),
    })
    await expect(driver.detect({})).resolves.toMatchObject({
      authenticated: true,
      account: "Logged in",
      email: null,
    })
  })

  it("does not start app-server when the CLI is missing", async () => {
    let started = 0
    const driver = new CodexDriver({
      detect: async () => ({ ...installed, installed: false, version: null }),
      transportFactory: () => {
        started += 1
        return new ScriptedTransport({ nativeThreadId: "th" })
      },
    })
    await expect(driver.detect({})).resolves.toMatchObject({ authenticated: null, account: null })
    expect(started).toBe(0)
  })
})

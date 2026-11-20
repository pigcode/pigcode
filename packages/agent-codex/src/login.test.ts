import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it, vi } from "vitest"
import type { AgentInstanceContext } from "@pigcode/plugin-sdk"
import { ManagedCodexRuntime } from "./managed-runtime"
import { CodexDriver } from "./driver"
import { ReplayCodexTransport } from "./transport"

interface Attempt {
  directory: string
  complete(): void
  notify(id: string): void
}

function fixture(root: string) {
  const attempts: Attempt[] = []
  const cancellations: string[] = []
  const verification = new Map<string, () => void>()
  const gated = new Set<string>()
  const late = new Set<string>()
  const settings = {
    setupMode: "managed",
    homePath: join(root, "shared"),
    shadowHomePath: join(root, "never-share-managed-credentials"),
  }
  const scope = (id: string): AgentInstanceContext => ({
    instanceId: id,
    dataDir: join(root, id),
    sharedDir: root,
    invalidate: () => {},
  })
  const home = (id: string) => join(scope(id).dataDir, "codex-home")
  const accountFile = (directory: string) => join(directory, "auth.json")
  const readAccount = (directory: string) => {
    try {
      return {
        type: "chatgpt",
        planType: "plus",
        email: readFileSync(accountFile(directory), "utf8"),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }
  const driver = () =>
    new CodexDriver({
      managedRuntime: new ManagedCodexRuntime({ local: async () => "fixture-codex" }),
      transportFactory: (launch) => {
        const directory = launch.env?.CODEX_HOME ?? ""
        return new (class extends ReplayCodexTransport {
          override send(line: string) {
            super.send(line)
            const { id, method, params } = JSON.parse(line)
            if (id === undefined) return
            let result: unknown = {}
            if (method === "account/read") {
              result = { account: readAccount(directory) }
              if (gated.has(directory)) {
                verification.set(directory, () => this.push({ id, result }))
                return
              }
            }
            if (method === "account/login/start") {
              const loginId = params.type === "chatgptDeviceCode" ? "device" : "browser"
              const notify = (id: string) =>
                this.push({
                  method: "account/login/completed",
                  params: { loginId: id, success: true },
                })
              attempts.push({
                directory,
                notify,
                complete: () => {
                  writeFileSync(accountFile(directory), "new@example.test", { mode: 0o600 })
                  notify(loginId)
                },
              })
              result =
                loginId === "device"
                  ? {
                      type: params.type,
                      loginId,
                      verificationUrl: "https://auth.openai.com/codex/device",
                      userCode: "ABCD-1234",
                    }
                  : {
                      type: params.type,
                      loginId,
                      authUrl: "https://auth.openai.com/oauth/authorize?q=fixture",
                    }
            }
            if (method === "account/login/cancel") {
              cancellations.push(params.loginId)
              if (late.has(directory))
                attempts.find((attempt) => attempt.directory === directory)?.complete()
            }
            if (method === "account/logout") {
              result = {}
              void rm(accountFile(directory), { force: true }).then(() => this.push({ id, result }))
              return
            }
            this.push({ id, result })
          }
        })([])
      },
    })
  return {
    attempts,
    cancellations,
    verification,
    gated,
    late,
    settings,
    scope,
    home,
    accountFile,
    driver,
  }
}

it("routes managed ChatGPT sign-in and sign-out to the selected instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-codex-oauth-"))
  const f = fixture(root)
  const { scope, settings, attempts, cancellations } = f
  const driver = f.driver()
  const one = scope("one"),
    two = scope("two")
  const auth = driver.accountSetup
  try {
    await expect(auth.auth({ action: "start" }, {}, one)).rejects.toThrow(
      /isolated|shadow|managed/i,
    )
    const start = await auth.auth({ action: "start" }, settings, one)
    await expect
      .poll(async () => (await auth.auth({ action: "status" }, settings, one)).phase)
      .toBe("waiting")
    expect((await auth.auth({ action: "status" }, settings, one)).authorizationUrl).toBe(
      "https://auth.openai.com/oauth/authorize?q=fixture",
    )
    expect((await auth.auth({ action: "status" }, settings, two)).phase).toBe("signed-out")
    attempts.at(-1)!.notify("wrong")
    await new Promise((resolve) => setImmediate(resolve))
    expect((await auth.auth({ action: "status" }, settings, one)).phase).toBe("waiting")
    await expect(
      auth.auth({ action: "cancel", flowId: start.flowId! }, settings, one),
    ).resolves.toMatchObject({ phase: "cancelled" })
    expect(cancellations).toEqual(["browser"])
    await auth.auth({ action: "start", methodId: "chatgptDeviceCode" }, settings, one)
    await expect
      .poll(async () => await auth.auth({ action: "status" }, settings, one))
      .toMatchObject({ phase: "waiting", userCode: "ABCD-1234" })
    attempts.at(-1)!.notify("device")
    await expect
      .poll(async () => (await auth.auth({ action: "status" }, settings, one)).phase)
      .toBe("failed")
    await auth.auth({ action: "start" }, settings, one)
    await expect
      .poll(async () => (await auth.auth({ action: "status" }, settings, one)).phase)
      .toBe("waiting")
    attempts.at(-1)!.complete()
    await expect
      .poll(async () => (await auth.auth({ action: "status" }, settings, one)).phase)
      .toBe("connected")
    expect(await readFile(f.accountFile(f.home("one")), "utf8")).toBe("new@example.test")
    expect((await auth.auth({ action: "status" }, settings, two)).phase).toBe("signed-out")
    expect((await auth.auth({ action: "logout" }, settings, one)).phase).toBe("signed-out")
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps existing credentials and shared sessions when verification is cancelled while another login completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-codex-cancel-verify-"))
  const f = fixture(root)
  const driver = f.driver()
  const resumed = f.driver()
  const existing = f.accountFile(f.home("one"))
  const rollout = join(f.settings.homePath, "sessions", "native-rollout.jsonl")
  try {
    await mkdir(f.home("one"), { recursive: true })
    await mkdir(dirname(rollout), { recursive: true })
    await writeFile(existing, "original@example.test", { mode: 0o600 })
    await writeFile(rollout, "original session")
    const one = f.scope("one"),
      two = f.scope("two")
    const auth = driver.accountSetup
    const startA = await auth.auth({ action: "start" }, f.settings, one)
    await expect.poll(() => f.attempts.length).toBe(1)
    const startB = await auth.auth(
      { action: "start", methodId: "chatgptDeviceCode" },
      f.settings,
      two,
    )
    await expect.poll(() => f.attempts.length).toBe(2)
    expect(startB.flowId).not.toBe(startA.flowId)
    const [first, second] = f.attempts as [Attempt, Attempt]
    f.gated.add(first.directory)
    first.complete()
    await vi.waitFor(() => expect(f.verification.has(first.directory)).toBe(true))
    expect(await readFile(existing, "utf8")).toBe("original@example.test")
    const cancellation = auth.auth({ action: "cancel", flowId: startA.flowId! }, f.settings, one)
    second.complete()
    await expect(cancellation).resolves.toMatchObject({ phase: "cancelled" })
    f.verification.get(first.directory)!()
    await expect
      .poll(async () => (await auth.auth({ action: "status" }, f.settings, two)).phase)
      .toBe("connected")
    await driver.close()
    expect(await readFile(existing, "utf8")).toBe("original@example.test")
    expect(await readFile(rollout, "utf8")).toBe("original session")
    await expect(
      resumed.accountSetup.auth({ action: "status" }, f.settings, one),
    ).resolves.toMatchObject({ phase: "connected" })
    await expect(
      resumed.accountSetup.auth({ action: "status" }, f.settings, two),
    ).resolves.toMatchObject({ phase: "connected" })
  } finally {
    for (const reply of f.verification.values()) reply()
    await driver.close()
    await resumed.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("discards credentials the CLI saves as it acknowledges login cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-codex-late-login-"))
  const f = fixture(root)
  const driver = f.driver(),
    restarted = f.driver()
  const scope = f.scope("one")
  try {
    const start = await driver.accountSetup.auth({ action: "start" }, f.settings, scope)
    await expect
      .poll(
        async () => (await driver.accountSetup.auth({ action: "status" }, f.settings, scope)).phase,
      )
      .toBe("waiting")
    const attempt = f.attempts[0]!
    f.late.add(attempt.directory)
    await expect(
      driver.accountSetup.auth({ action: "cancel", flowId: start.flowId! }, f.settings, scope),
    ).resolves.toMatchObject({ phase: "cancelled" })
    await driver.close()
    await expect(readFile(f.accountFile(f.home("one")), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(
      restarted.accountSetup.auth({ action: "status" }, f.settings, scope),
    ).resolves.toMatchObject({ phase: "signed-out" })
  } finally {
    await driver.close()
    await restarted.close()
    await rm(root, { recursive: true, force: true })
  }
})

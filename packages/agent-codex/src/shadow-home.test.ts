import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { CodexDriver } from "./driver"
import type { CodexLaunch } from "./launch"
import { ScriptedTransport } from "./scripted-transport"

it("starts both accounts with private credentials and the same shared Codex sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-shadow-"))
  const shared = join(root, "shared")
  const a = join(root, "a")
  const b = join(root, "b")
  const launches: CodexLaunch[] = []
  const driver = new CodexDriver({
    transportFactory: (launch) => {
      launches.push(launch)
      return new ScriptedTransport({ nativeThreadId: "native" })
    },
  })
  try {
    await mkdir(shared)
    await writeFile(join(shared, "config.toml"), 'model = "test"')
    await writeFile(join(shared, "auth.json"), "main")
    const first = { homePath: shared, shadowHomePath: a }
    await Promise.all([
      driver.listModels(first),
      driver.createSession({ threadId: "one", cwd: root, settings: first }),
    ])
    await driver.listModels({ homePath: shared, shadowHomePath: b })
    expect(launches.map((item) => item.env?.CODEX_HOME)).toEqual([a, a, b])
    expect(launches[0]?.args).toContain('cli_auth_credentials_store="file"')
    expect(driver.continuationKey(first)).toBe(
      driver.continuationKey({ homePath: shared, shadowHomePath: b }),
    )
    expect(await readFile(join(a, "config.toml"), "utf8")).toContain("test")
    await expect(stat(join(a, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(join(a, "auth.json"), "account a")
    await expect(stat(join(b, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(shared, "auth.json"), "utf8")).toBe("main")
    await writeFile(join(a, "sessions", "history.txt"), "turn")
    expect(await readFile(join(b, "sessions", "history.txt"), "utf8")).toBe("turn")
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("rejects overlapping homes, private symlinks and user-owned conflicting files before spawning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-shadow-conflict-"))
  let started = 0
  const driver = new CodexDriver({
    transportFactory: () => {
      started++
      return new ScriptedTransport({ nativeThreadId: "unused" })
    },
  })
  try {
    const shared = join(root, "shared"),
      shadow = join(root, "shadow")
    await Promise.all([mkdir(shared), mkdir(shadow)])
    const open = (homePath: string, shadowHomePath: string) =>
      driver.createSession({ threadId: "x", cwd: root, settings: { homePath, shadowHomePath } })
    await expect(open(shared, shared)).rejects.toThrow()
    await expect(open(shared, join(shared, "nested"))).rejects.toThrow()
    await writeFile(join(shared, "auth.json"), "private")
    if (process.platform !== "win32") {
      await symlink(join(shared, "auth.json"), join(shadow, "auth.json"))
      await expect(open(shared, shadow)).rejects.toThrow(/auth.json/)
      await rm(join(shadow, "auth.json"))
    }
    await writeFile(join(shared, "config.toml"), "shared")
    await writeFile(join(shadow, "config.toml"), "private config")
    await expect(open(shared, shadow)).rejects.toThrow(/config.toml/)
    expect(await readFile(join(shadow, "config.toml"), "utf8")).toBe("private config")
    expect(started).toBe(0)
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps separate app-servers when two accounts resume the same shared native thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-shadow-thread-"))
  const transports: ScriptedTransport[] = []
  const driver = new CodexDriver({
    transportFactory: () => {
      const rpc = new ScriptedTransport({ nativeThreadId: "shared-native" })
      transports.push(rpc)
      return rpc
    },
  })
  try {
    const create = (account: string) =>
      driver.createSession({
        cwd: root,
        threadId: account,
        nativeSessionId: "shared-native",
        instance: {
          instanceId: account,
          dataDir: join(root, account),
          sharedDir: root,
          invalidate() {},
        },
        settings: { homePath: join(root, "shared"), shadowHomePath: join(root, account) },
      })
    const first = await create("one"),
      second = await create("two")
    expect(transports.map(({ closed }) => closed)).toEqual([false, false])
    await driver.dispose(first)
    expect(transports.map(({ closed }) => closed)).toEqual([true, false])
    await driver.dispose(second)
    expect(transports.map(({ closed }) => closed)).toEqual([true, true])
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { apply as settings } from "../services/settings"
import { createAgentCatalog } from "./agent-catalog"

it("keeps credentials out of ordinary settings and renderer responses while resolving the correct copy after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-instance-secrets-"))
  const file = join(dir, "settings.json")
  const host = async () => {
    const ctx = new Context()
    await ctx.plugin(settings, { path: file })
    return { ctx, agents: createAgentCatalog(ctx, new Map(), join(dir, "agents")) }
  }
  const one = await host()
  try {
    const instance = one.agents.createInstance("example", "First", {
      values: {
        apiKey: { secret: "example-key-123" },
        environment: [{ name: "TOKEN", value: "example-token-456", sensitive: true }],
      },
    })
    expect(JSON.stringify(instance)).not.toContain("example-key-123")
    expect(await readFile(file, "utf8")).not.toContain("example-token-456")
    const two = await host()
    try {
      const values = two.agents.settingsForInstance("example", instance.instanceId)
      expect(values.apiKey).toEqual({ configured: true })
      const copied = two.agents.createInstance("example", "Second", {
        copyFrom: instance.instanceId,
      })
      two.agents.updateSettings(
        "example",
        { ...values, apiKey: { secret: "rotated" } },
        instance.instanceId,
      )
      expect(await two.agents.runtimeSettings("example", copied.instanceId)).toMatchObject({
        apiKey: "example-key-123",
      })
      expect(await two.agents.runtimeSettings("example", instance.instanceId)).toMatchObject({
        apiKey: "rotated",
        environment: [{ name: "TOKEN", value: "example-token-456" }],
      })
      expect(JSON.stringify(two.agents.instances("example"))).not.toContain("example-token-456")
      expect(() =>
        two.agents.createInstance("example", "Forged", {
          values: { apiKey: { configured: true } },
        }),
      ).toThrow()
      two.agents.removeInstance(instance.instanceId)
      expect((await two.agents.runtimeSettings("example", copied.instanceId)).apiKey).toBe(
        "example-key-123",
      )
    } finally {
      await two.ctx.fiber.dispose()
    }
  } finally {
    await one.ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it("resolves an external reference only at launch and never returns the external value to the renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-external-secret-"))
  const { writeFile } = await import("node:fs/promises")
  const { delimiter } = await import("node:path")
  const { vi } = await import("vitest")
  const executable = join(root, process.platform === "win32" ? "op.mjs" : "op")
  await writeFile(
    executable,
    '#!/usr/bin/env node\nif (process.argv.slice(2).join("|") !== "read|--no-newline|op://Test vault/Account/field") process.exit(2)\nprocess.stdout.write("from-fake-vault")\n',
    { mode: 0o700 },
  )
  if (process.platform === "win32")
    await writeFile(join(root, "op.cmd"), '@SETLOCAL\r\nnode "%~dp0op.mjs" %*\r\n')
  vi.stubEnv("PATH", root + delimiter + process.env.PATH)
  const ctx = new Context()
  try {
    await ctx.plugin(settings, { path: join(root, "settings.json") })
    const agents = createAgentCatalog(ctx, new Map(), join(root, "agents"))
    const reference = { reference: "op://Test vault/Account/field" }
    const item = agents.createInstance("example", "External", { values: { apiKey: reference } })
    expect(item.values.apiKey).toEqual(reference)
    expect(await agents.runtimeSettings("example", item.instanceId)).toMatchObject({
      apiKey: "from-fake-vault",
    })
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("from-fake-vault")
  } finally {
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

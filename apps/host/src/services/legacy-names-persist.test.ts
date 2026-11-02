/**
 * 旧名字迁移写回文件时的安全性：改写前备份一次、以后不覆盖；profile 写不进去（只读、磁盘满）时
 * settings 服务照样起来、用迁移后的值，插件列表照样读出迁移后的条目，下一次写入时再落盘。
 */
import { Context } from "cordis"
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stringify } from "yaml"
import { PRE_RENAME_BACKUP_SUFFIX } from "./legacy-names"
import { readPluginRecords } from "./plugin-manager"
import { apply as settings } from "./settings"

/** root 不受目录权限限制，只读目录模拟不了写入失败。 */
const canDenyWrites = process.platform !== "win32" && process.getuid?.() !== 0

const OLD_SETTINGS = {
  "providers.codex": { binaryPath: "/opt/codex" },
  "agents.defaultProvider": "codex",
}
const MIGRATED_SETTINGS = { "agents.codex": { binaryPath: "/opt/codex" }, defaultAgent: "codex" }
const OLD_PLUGINS = stringify({
  plugins: [{ id: "provider.pigcode-echo", name: "pigcode-echo", disabled: true }],
})

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-persist-"))
  await writeFile(join(dir, "settings.json"), JSON.stringify(OLD_SETTINGS))
  await writeFile(join(dir, "plugins.yml"), OLD_PLUGINS)
  return dir
}

async function startSettings(dir: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(settings, { path: join(dir, "settings.json") })
  return ctx
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("backups before the rename rewrite", () => {
  it("backs up settings.json and plugins.yml once and never overwrites the backups", async () => {
    const dir = await profile()
    const ctx = await startSettings(dir)
    await readPluginRecords(dir)
    await ctx.fiber.dispose()
    const settingsBackup = join(dir, `settings.json${PRE_RENAME_BACKUP_SUFFIX}`)
    const pluginsBackup = join(dir, `plugins.yml${PRE_RENAME_BACKUP_SUFFIX}`)
    expect(await readJson(settingsBackup)).toEqual(OLD_SETTINGS)
    expect(await readFile(pluginsBackup, "utf8")).toBe(OLD_PLUGINS)
    expect(await readJson(join(dir, "settings.json"))).toEqual(MIGRATED_SETTINGS)

    // 已经迁移过：再启动不备份也不改写。
    const again = await startSettings(dir)
    await readPluginRecords(dir)
    await again.fiber.dispose()
    expect((await readdir(dir)).filter((name) => name.endsWith(".bak")).sort()).toEqual([
      `plugins.yml${PRE_RENAME_BACKUP_SUFFIX}`,
      `settings.json${PRE_RENAME_BACKUP_SUFFIX}`,
    ])

    // 旧名字又出现了（例如用户装回旧版本又用了一阵）：照样迁移，但第一份备份不被覆盖。
    await writeFile(join(dir, "settings.json"), JSON.stringify({ "providers.claude": { a: 1 } }))
    await writeFile(
      join(dir, "plugins.yml"),
      stringify({ plugins: [{ id: "provider.x", name: "x" }] }),
    )
    const third = await startSettings(dir)
    await readPluginRecords(dir)
    await third.fiber.dispose()
    expect(await readJson(join(dir, "settings.json"))).toEqual({ "agents.claude": { a: 1 } })
    expect(await readJson(settingsBackup)).toEqual(OLD_SETTINGS)
    expect(await readFile(pluginsBackup, "utf8")).toBe(OLD_PLUGINS)
  })
})

describe.skipIf(!canDenyWrites)("a profile that cannot be written", () => {
  it("still starts the settings service with the migrated values and persists on the next set", async () => {
    const dir = await profile()
    await chmod(dir, 0o555)
    try {
      const ctx = await startSettings(dir)
      expect(ctx.settings.snapshot()).toEqual(MIGRATED_SETTINGS)
      expect(ctx.settings.get("agents.codex")).toEqual({ binaryPath: "/opt/codex" })
      expect(await readJson(join(dir, "settings.json"))).toEqual(OLD_SETTINGS)
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("could not back up"))
      await chmod(dir, 0o755)
      ctx.settings.set("appearance", "dark")
      expect(await readJson(join(dir, "settings.json"))).toEqual({
        ...MIGRATED_SETTINGS,
        appearance: "dark",
      })
      await ctx.fiber.dispose()
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it("keeps the settings service up when the backup exists but the rewrite fails", async () => {
    const dir = await profile()
    await writeFile(join(dir, `settings.json${PRE_RENAME_BACKUP_SUFFIX}`), "{}")
    await chmod(dir, 0o555)
    try {
      const ctx = await startSettings(dir)
      expect(ctx.settings.snapshot()).toEqual(MIGRATED_SETTINGS)
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("could not write the migrated settings"),
        expect.anything(),
      )
      await ctx.fiber.dispose()
    } finally {
      await chmod(dir, 0o755)
    }
    expect(await readJson(join(dir, "settings.json"))).toEqual(OLD_SETTINGS)
  })

  it("tolerates a plugins.yml write-back failure and still returns the migrated entries", async () => {
    const dir = await profile()
    await chmod(dir, 0o555)
    try {
      const records = await readPluginRecords(dir)
      expect(records.map((record) => [record.id, record.disabled])).toEqual([
        ["agent.pigcode-echo", true],
      ])
    } finally {
      await chmod(dir, 0o755)
    }
    expect(await readFile(join(dir, "plugins.yml"), "utf8")).toBe(OLD_PLUGINS)
    // 目录能写以后，下一次读取完成迁移。
    await readPluginRecords(dir)
    expect(await readFile(join(dir, "plugins.yml"), "utf8")).toContain("agent.pigcode-echo")
  })
})

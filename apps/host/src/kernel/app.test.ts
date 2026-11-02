import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createHostApp, dumpConfig, requireCoreService } from "./app"

describe("host kernel", () => {
  it("loads a profile and dumps its entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-kernel-"))
    await writeFile(
      join(dir, "desktop.yml"),
      [
        "plugins:",
        "  - id: core.settings",
        "    name: ./fixture-plugin.mjs",
        "  - id: core.disabled",
        "    name: ./fixture-plugin.mjs",
        "    disabled: true",
      ].join("\n"),
    )
    await writeFile(join(dir, "fixture-plugin.mjs"), "export function apply() {}\n")

    const ctx = await createHostApp({ profileDir: dir, profileName: "desktop" })
    const config = dumpConfig(ctx)
    expect(config.entries.map((entry) => entry.id)).toEqual(["core.settings", "core.disabled"])
    expect(config.entries[1]!.disabled).toBe(true)
    await ctx.fiber.dispose()
  })

  it("surfaces why a core service failed to start instead of leaving it missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-kernel-"))
    await writeFile(
      join(dir, "desktop.yml"),
      ["plugins:", "  - id: core.storage", "    name: ./storage.mjs"].join("\n"),
    )
    // 和真的 storage 一样：数据库打不开时 apply 抛错，Cordis 只记日志，服务就缺席了。
    await writeFile(
      join(dir, "storage.mjs"),
      'export function apply() { throw new Error("could not back up the database: disk full") }\n',
    )
    const ctx = await createHostApp({ profileDir: dir, profileName: "desktop" })
    await expect(requireCoreService(ctx, "core.storage", "storage")).rejects.toThrow(
      "core.storage failed to start: could not back up the database: disk full",
    )
    await expect(requireCoreService(ctx, "core.missing", "nothing")).rejects.toThrow(
      "core.missing failed to start: the nothing service is not available",
    )
    await ctx.fiber.dispose()
  })
})

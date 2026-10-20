import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createHostApp, dumpConfig } from "./app"

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
    await writeFile(
      join(dir, "fixture-plugin.mjs"),
      "export function apply() {}\n",
    )

    const ctx = await createHostApp({ profileDir: dir, profileName: "desktop" })
    const config = dumpConfig(ctx)
    expect(config.entries.map((entry) => entry.id)).toEqual(["core.settings", "core.disabled"])
    expect(config.entries[1]!.disabled).toBe(true)
    await ctx.fiber.dispose()
  })
})

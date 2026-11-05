/** 验证 pigcode CLI：--dump-config 的输出与各种错误参数的退出码。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runCli } from "./cli"

const dirs: string[] = []
const profileDir = process.env.PIGCODE_PROFILE_DIR

afterEach(async () => {
  process.env.PIGCODE_PROFILE_DIR = profileDir
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 写一个最小 profile：一个启用的插件和一个停用的插件。 */
async function writeProfile(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-cli-"))
  dirs.push(dir)
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
  process.env.PIGCODE_PROFILE_DIR = dir
}

describe("runCli", () => {
  it("prints the whole config tree for --dump-config and exits 0", async () => {
    await writeProfile()
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    expect(await runCli(["--dump-config"])).toBe(0)

    const config = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      entries: Array<{ id: string; disabled: boolean }>
    }
    expect(config.entries.map((entry) => entry.id)).toEqual(["core.settings", "core.disabled"])
    expect(config.entries[1]?.disabled).toBe(true)
  })

  it("exits 2 and says what to do when there is no command", async () => {
    await writeProfile()
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    expect(await runCli([])).toBe(2)
    expect(error.mock.calls.flat().join(" ")).toContain("--dump-config")
  })

  it("exits 2 when --profile has no value", async () => {
    expect(await runCli(["--profile"])).toBe(2)
  })
})

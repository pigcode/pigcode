import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runCliUpdate } from "./cli-update-process"

describe("CLI update process", () => {
  it("passes paths as arguments and collects installer output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pigcode-update-process-"))
    const target = join(directory, "version & spaces.txt")
    const output: string[] = []
    try {
      await runCliUpdate(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], '2.0.0'); console.log('updated')",
          target,
        ],
        process.env,
        { signal: new AbortController().signal, onOutput: (text) => output.push(text) },
      )
      expect(await readFile(target, "utf8")).toBe("2.0.0")
      expect(output.join("")).toContain("updated")
      await expect(
        runCliUpdate(process.execPath, ["-e", "process.exit(7)"], process.env, {
          signal: new AbortController().signal,
          onOutput: () => undefined,
        }),
      ).rejects.toThrow("code 7")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("ends the updater when the host aborts it", async () => {
    const controller = new AbortController()
    await expect(
      runCliUpdate(
        process.execPath,
        ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
        process.env,
        { signal: controller.signal, onOutput: () => controller.abort() },
      ),
    ).rejects.toThrow("cancelled")
  })
})

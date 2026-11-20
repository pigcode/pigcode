import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { MuseDriver } from "./driver"
import { museUpdateAvailable, parseMuseVersion } from "./maintenance"

it("compares the native Muse numeric release/build and loose CLI versions", () => {
  expect(parseMuseVersion("Muse Code 1.4.24 (1.4.24-R18.9)")).toBe("1.4.24-R18.9")
  expect(museUpdateAvailable("1.4.24-R9.8", "1.4.24-R18.1")).toBe(true)
  expect(museUpdateAvailable("1.4.24-R18.11", "1.4.24-R18.9")).toBe(false)
  expect(museUpdateAvailable("1.4.24", "1.4.24-R18.1")).toBe(false)
  expect(museUpdateAvailable("1.4.23", "1.4.24-R18.1")).toBe(true)
})
it.skipIf(process.platform === "win32")(
  "refreshes only the official Muse launcher and its own release channel",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pigcode-muse-maintain-"))
    const path = join(directory, "muse launcher"),
      updated = join(directory, "updated")
    const driver = new MuseDriver()
    const request = vi.fn(async () => Response.json({ version: "1.4.24-R10.1" }))
    vi.stubGlobal("fetch", request)
    try {
      const script =
        '#!/bin/sh\n# muse-code/launcher-2\nif [ "$MUSE_SYNC_UPDATE" = 1 ] && [ "$MUSE_NO_AUTO_UPDATE" = 0 ] && [ "$MUSE_UPDATE_INTERVAL_SECONDS" = 0 ]; then echo "$MUSE_CHANNEL" > "$MUSE_TEST_UPDATED"; fi\nif [ -f "$MUSE_TEST_UPDATED" ]; then echo "Muse 1.4.24 (1.4.24-R10.1)"; else echo "Muse 1.4.24 (1.4.24-R9.1)"; fi\n'
      await writeFile(path, script)
      await chmod(path, 0o755)
      const settings = {
        binaryPath: path,
        environment: [
          { name: "MUSE_TEST_UPDATED", value: updated },
          { name: "MUSE_CHANNEL", value: "muse-canary" },
        ],
      }
      const plan = await driver.prepareCliUpdate(settings)
      expect(request).toHaveBeenCalledWith(
        "https://api.meta.ai/muse-code/channels/muse-canary",
        expect.anything(),
      )
      expect(plan).toMatchObject({
        currentVersion: "1.4.24-R9.1",
        latestVersion: "1.4.24-R10.1",
        available: true,
      })
      expect(plan.run).toBeTypeOf("function")
      await plan.run!({ signal: new AbortController().signal, onOutput: () => {} })
      expect(await plan.verify()).toBe("1.4.24-R10.1")
      expect((await readFile(updated, "utf8")).trim()).toBe("muse-canary")
      await writeFile(path, '#!/bin/sh\necho "1.4.23"\n')
      expect(await driver.prepareCliUpdate(settings)).toMatchObject({
        reason: "unknown-installation",
        command: null,
      })
      expect((await driver.prepareCliUpdate(settings)).run).toBeUndefined()
      const queries = request.mock.calls.length
      expect(
        (
          await driver.prepareCliUpdate({
            binaryPath: path,
            environment: [{ name: "MUSE_CHANNEL", value: "private" }],
          })
        ).run,
      ).toBeUndefined()
      expect(request).toHaveBeenCalledTimes(queries)
      request.mockResolvedValueOnce(Response.json({ version: "1.4.24" }))
      expect((await driver.prepareCliUpdate(settings)).latestVersion).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      await driver.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

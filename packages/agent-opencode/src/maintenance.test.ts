import { realpath, chmod, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { OpenCodeDriver } from "./driver"
import { prepareOpenCodeUpdate, nativeOpenCode } from "./maintenance"

it("never probes or changes a local executable for a remote OpenCode endpoint", async () => {
  const probe = vi.fn(),
    retire = vi.fn()
  const plan = await prepareOpenCodeUpdate(
    { serverUrl: "https://example.test/opencode", binaryPath: "/missing" },
    probe,
    retire,
  )
  expect(plan).toMatchObject({
    currentVersion: null,
    available: false,
    reason: "unsupported",
    command: null,
  })
  expect(await plan.verify()).toBeNull()
  expect(probe).not.toHaveBeenCalled()
  expect(retire).not.toHaveBeenCalled()
})
it("restricts the native curl updater to the executable it can replace", () => {
  const home = join(tmpdir(), "test home")
  expect(nativeOpenCode(join(home, ".opencode", "bin", "opencode"), home)).toBe(true)
  expect(nativeOpenCode(join(home, "elsewhere", ".opencode", "bin", "opencode"), home)).toBe(false)
})
it.skipIf(process.platform === "win32").each([1, 2] as const)(
  "pins the local OpenCode %s installation to its own release generation",
  async (major) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pigcode-opencode-maintain-"))),
      bin = join(directory, "bin"),
      log = join(directory, "install.log")
    const name = major === 1 ? "opencode-ai" : "@opencode/cli",
      current = major + ".0.1",
      latest = major + ".2.3"
    const packageBin = join(directory, "lib", "node_modules", name, "bin")
    const driver = new OpenCodeDriver()
    const request = vi.fn(async () => Response.json({ version: latest }))
    vi.stubGlobal("fetch", request)
    try {
      await Promise.all([mkdir(bin, { recursive: true }), mkdir(packageBin, { recursive: true })])
      const executable = join(bin, "opencode"),
        native = join(packageBin, "opencode")
      await writeFile(native, '#!/bin/sh\necho "opencode v' + current + '"\n')
      await chmod(native, 0o755)
      await symlink(native, executable)
      const pkgManager = join(bin, "npm")
      await writeFile(pkgManager, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PIGCODE_TEST_UPDATE_LOG"\n')
      await chmod(pkgManager, 0o755)
      const plan = await driver.prepareCliUpdate({
        serverUrl: "http://127.0.0.1:1",
        binaryPath: executable,
        environment: [{ name: "PIGCODE_TEST_UPDATE_LOG", value: log }],
      })
      expect(await plan.verify()).toBe(current)
      expect(plan.latestVersion).toBe(latest)
      expect(plan.run).toBeTypeOf("function")
      await plan.run!({ signal: new AbortController().signal, onOutput: () => {} })
      expect((await readFile(log, "utf8")).trim().split("\n")).toContain(name + "@" + latest)
      expect(request).toHaveBeenCalledWith(
        "https://registry.npmjs.org/" + encodeURIComponent(name) + "/latest",
        expect.anything(),
      )
      const custom = join(directory, "unknown")
      await writeFile(custom, '#!/bin/sh\necho "' + current + '"\n')
      await chmod(custom, 0o755)
      expect((await driver.prepareCliUpdate({ binaryPath: custom })).run).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      await driver.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

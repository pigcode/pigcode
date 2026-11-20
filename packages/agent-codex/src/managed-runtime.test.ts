import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"
import { CodexDriver } from "./driver"
import { codexRelease, ManagedCodexRuntime, type CodexRelease } from "./managed-runtime"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function scope(root: string, id: string) {
  return {
    instanceId: id,
    dataDir: join(root, id),
    sharedDir: join(root, "shared"),
    invalidate() {},
  }
}

function withTemp(run: (dir: string) => Promise<void>) {
  return mkdtemp(join(tmpdir(), "pigcode-codex-install-test-")).then(async (dir) => {
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

async function releaseFixture(root: string) {
  const dir = join(root, "fixture")
  const metadata = {
    layoutVersion: 1,
    target: "test-linux",
    version: "9.2.0",
    entrypoint: "bin/codex",
  }
  await mkdir(join(dir, "bin"), { recursive: true })
  await mkdir(join(dir, "codex-path"))
  await writeFile(join(dir, "codex-package.json"), JSON.stringify(metadata))
  const fixture =
    '#!/bin/sh\ncase "$1" in\n--version) echo "codex-cli 9.2.0";;\napp-server) test "$2" = "--help";;\n*) exit 2;;\nesac\n'
  for (const path of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"])
    await writeFile(join(dir, path), fixture, { mode: 0o700 })
  const archive = join(root, "release.tar.gz")
  await promisify(execFile)("tar", [
    "-czf",
    archive,
    "-C",
    dir,
    "bin",
    "codex-path",
    "codex-package.json",
  ])
  const bytes = await readFile(archive)
  const release: CodexRelease = {
    version: metadata.version,
    target: metadata.target,
    command: metadata.entrypoint,
    digest: createHash("sha256").update(bytes).digest("hex"),
    url: "https://example.invalid/codex.tar.gz",
  }
  return { release, body: () => new Response(Uint8Array.from(bytes)) }
}

it("pins an official SHA-256 for every target", () => {
  for (const os of ["darwin", "linux", "win32"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      const release = codexRelease(os, arch)!
      expect(release.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(release.url).toBe(
        `https://github.com/openai/codex/releases/download/rust-v${release.version}/codex-package-${release.target}.tar.gz`,
      )
    }
  }
})

it("keeps detection, account status, catalog, runs and update checks read-only until starting managed sign-in", async () => {
  await withTemp(async (root) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("fixture download failed")
    })
    const runtime = new ManagedCodexRuntime({
      local: async () => null,
      fetcher,
      release: codexRelease("linux", "x64")!,
    })
    const driver = new CodexDriver({
      managedRuntime: runtime,
      transportFactory: () => {
        throw new Error("unexpected process")
      },
    })
    const settings = { setupMode: "managed", homePath: join(root, "no-home") },
      account = scope(root, "account")
    try {
      expect(await driver.detect(settings, account)).toMatchObject({
        installed: false,
        authenticated: null,
      })
      expect(await driver.accountSetup.auth({ action: "status" }, settings, account)).toMatchObject(
        { phase: "signed-out" },
      )
      expect(await driver.listModels(settings, account)).toEqual([])
      expect(await driver.prepareCliUpdate(settings, account)).toMatchObject({
        reason: "not-installed",
        available: false,
      })
      await expect(
        driver.createSession({ threadId: "t", cwd: root, settings, instance: account }),
      ).rejects.toThrow(/signing in/)
      expect(await readdir(root)).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
      expect(await driver.accountSetup.auth({ action: "start" }, settings, account)).toMatchObject({
        phase: "starting",
      })
      await expect
        .poll(async () => driver.accountSetup.auth({ action: "status" }, settings, account))
        .toMatchObject({ phase: "failed", error: "fixture download failed" })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await readdir(join(account.sharedDir, "codex-runtime"))).toEqual([])
    } finally {
      await driver.close()
    }
  })
})

it.skipIf(process.platform === "win32")(
  "shares one verified installation across accounts and restarts, lets one account cancel, and prefers a local CLI",
  async () => {
    await withTemp(async (root) => {
      const { release, body } = await releaseFixture(root)
      const wait = deferred()
      const fetcher = vi.fn<typeof fetch>(async () => {
        await wait.promise
        return body()
      })
      const a = scope(root, "a"),
        b = scope(root, "b"),
        one = new AbortController(),
        two = new AbortController()
      const watching = vi.spyOn(two.signal, "addEventListener")
      const options = { release, fetcher, local: async () => null }
      const runtime = new ManagedCodexRuntime(options)
      const first = runtime.resolve({}, a, one.signal)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      const second = runtime.resolve({}, b, two.signal)
      await vi.waitFor(() =>
        expect(watching).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }),
      )
      one.abort()
      await expect(first).rejects.toMatchObject({ name: "AbortError" })
      wait.resolve()
      const cached = await second
      expect(cached).toBe(join(a.sharedDir, "codex-runtime", "9.2.0-test-linux", "bin/codex"))
      expect(await new ManagedCodexRuntime(options).resolve({}, a)).toBe(cached)
      expect(
        await new ManagedCodexRuntime({ ...options, local: async () => "/existing/codex" }).resolve(
          {},
          b,
        ),
      ).toBe("/existing/codex")
      expect(fetcher).toHaveBeenCalledTimes(1)
    })
  },
)

it.skipIf(process.platform === "win32")(
  "cleans staging after a failed checksum or cancellation, and can retry the same release",
  async () => {
    await withTemp(async (root) => {
      const { release, body } = await releaseFixture(root)
      const started = deferred()
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("wrong checksum"))
        .mockImplementationOnce(async (_url, options) => {
          started.resolve()
          return new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            }),
          )
        })
        .mockImplementation(async () => body())
      const runtime = new ManagedCodexRuntime({ local: async () => null, release, fetcher })
      const account = scope(root, "one")
      await expect(runtime.resolve({}, account, new AbortController().signal)).rejects.toThrow(
        /checksum/,
      )
      const cache = join(account.sharedDir, "codex-runtime")
      expect(await readdir(cache)).toEqual([])
      const cancel = new AbortController(),
        done = runtime.resolve({}, account, cancel.signal)
      await started.promise
      cancel.abort()
      await expect(done).rejects.toMatchObject({ name: "AbortError" })
      expect(await readdir(cache)).toEqual([])
      expect(await runtime.resolve({}, account)).toBeNull()
      expect(await runtime.resolve({}, account, new AbortController().signal)).toContain(
        "9.2.0-test-linux",
      )
      expect(await readdir(cache)).toEqual(["9.2.0-test-linux"])
    })
  },
)

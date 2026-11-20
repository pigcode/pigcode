import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, it, vi } from "vitest"
import { AntigravityInstallation } from "./installation"
import { openAcp } from "./connection"
import { standaloneRoot } from "./standalone-runtime"
import type { AgentInstanceContext } from "@pigcode/plugin-sdk"

vi.mock("./connection", async (load) => ({
  ...(await load<typeof import("./connection")>()),
  openAcp: vi.fn(() => ({
    initialize: async () => ({
      agentInfo: { name: "antigravity-acp", version: "1.5.0" },
      authMethods: [{ id: "oauth-business" }, { id: "agent-platform" }],
    }),
    close: async () => undefined,
  })),
}))

// 四个只含自身文件名的 ZIP 条目，包含 Unix 和 Windows 的入口与 harness。
const archive = Buffer.from(
  "UEsDBBQAAAAAAAAAIVxpLoPuEgAAABIAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyYWd5X2FjcF9zZXJ2ZXIucGFyUEsDBBQAAAAAAAAAIVwtY73sEgAAABIAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlYWd5X2FjcF9zZXJ2ZXIuZXhlUEsDBBQAAAAAAAAAIVzqsVR0FQAAABUAAAAVAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsbG9jYWxoYXJuZXNzX2V4dGVybmFsUEsDBBQAAAAAAAAAIVz9cGoBGQAAABkAAAAZAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZWxvY2FsaGFybmVzc19leHRlcm5hbC5leGVQSwECFAMUAAAAAAAAACFcaS6D7hIAAAASAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAAAAAAhXC1jvewSAAAAEgAAABIAAAAAAAAAAAAAAO2BQgAAAGFneV9hY3Bfc2VydmVyLmV4ZVBLAQIUAxQAAAAAAAAAIVzqsVR0FQAAABUAAAAVAAAAAAAAAAAAAADtgYQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwECFAMUAAAAAAAAACFc/XBqARkAAAAZAAAAGQAAAAAAAAAAAAAA7YHMAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAABAAEAAoBAAAcAQAAAAA=",
  "base64",
)
const digest = createHash("sha256").update(archive).digest("hex")
const bin = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"
const sibling = process.platform === "win32" ? "localharness_external.exe" : "localharness_external"
const business = { authMethod: "oauth-business", gcpProject: "fixture", gcpLocation: "global" }
const vertex = { authMethod: "agent-platform", apiKey: "stub" }
const commandOverride = { ...business, binaryPath: join(tmpdir(), "local", "agy") }

function registry(digest: string) {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch === "x64" ? "x86_64" : process.arch
  const folder = process.platform === "darwin" ? "macos" : platform
  const url =
    "https://dl.google.com/agy-extensions/releases/" +
    folder +
    "/agy-acp-server-1.5.0-" +
    platform +
    "-" +
    arch +
    ".zip"
  const target = platform + "-" + (arch === "arm64" ? "aarch64" : arch)
  return {
    agents: [
      {
        id: "antigravity-acp",
        name: "Google Antigravity",
        version: "1.5.0",
        description: "Google",
        distribution: {
          binary: {
            [target]: {
              cmd: "./" + bin,
              archive: url,
              sha256: digest,
              ...(platform === "linux" ? { args: ["--uid="] } : {}),
            },
          },
        },
      },
    ],
  }
}

const scope = (root: string, name: string): AgentInstanceContext => ({
  sharedDir: join(root, "shared"),
  dataDir: join(root, name),
  instanceId: name,
  invalidate() {},
})

it("only an explicit connection prepares the paired runtime and opts in each Enterprise or Vertex key instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-enterprise-install-"))
  const urls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    return url.endsWith("registry.json")
      ? Response.json(registry(digest))
      : new Response(new Uint8Array(archive))
  }
  const installer = new AntigravityInstallation(fetcher),
    a = scope(root, "a"),
    b = scope(root, "b")
  try {
    const personal = await installer.resolve({}, a)
    expect(await installer.resolve(business, a)).toBe(personal)
    const custom = await installer.prepareEnterprise(
      commandOverride,
      a,
      new AbortController().signal,
    )
    expect(custom.command).toBe(commandOverride.binaryPath)
    custom.release()
    expect(urls).toEqual([])
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      installer.prepareEnterprise(business, a, signal),
      installer.prepareEnterprise(business, b, signal),
    ])
    expect(first.command).toBe(second.command)
    expect(basename(first.command)).toBe(bin)
    expect(await stat(join(first.command, "..", sibling))).toMatchObject({ size: sibling.length })
    expect(urls.filter((url) => url.endsWith(".zip"))).toHaveLength(1)
    expect(vi.mocked(openAcp)).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          AGY_ACP_FORCE_FILE_STORAGE: "1",
          ANTIGRAVITY_HARNESS_PATH: expect.stringContaining(sibling),
        }),
      }),
    )
    const later = new AntigravityInstallation(async () => {
      throw new Error("offline")
    })
    expect(await later.resolve(business, a)).toBe(first.command)
    expect(await later.resolve(vertex, a)).toBe(first.command)
    expect(
      await later.resolve(
        { authMethod: "agent-platform", gcpProject: "fixture", gcpLocation: "global" },
        a,
      ),
    ).toBe(personal)
    expect(await later.resolve(business, scope(root, "never-used"))).toBe(personal)
    expect(await later.resolve(commandOverride, a)).toBe(commandOverride.binaryPath)
    const check = await installer.prepare(business, a)
    expect(check).toMatchObject({
      target: standaloneRoot(a),
      currentVersion: "1.5.0",
      latestVersion: "1.5.0",
      available: false,
    })
    await expect(installer.remove(a, [], business)).rejects.toThrow("in use")
    first.release()
    second.release()
    await installer.remove(a, [], business)
    // 删除后保持独立模式，不能自动使用 PATH 中的个人凭据。
    expect(await later.resolve(business, b)).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("does not select a damaged archive and a later explicit retry can succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-enterprise-checksum-")),
    a = scope(root, "a")
  try {
    const failed = new AntigravityInstallation(async (input) =>
      String(input).endsWith("registry.json")
        ? Response.json(registry("f".repeat(64)))
        : new Response(new Uint8Array(archive)),
    )
    await expect(failed.prepareEnterprise(vertex, a, new AbortController().signal)).rejects.toThrow(
      "checksum",
    )
    expect(await failed.resolve(vertex, a)).toBe(await failed.resolve({}, a))
    const retry = new AntigravityInstallation(async (input) =>
      String(input).endsWith("registry.json")
        ? Response.json(registry(digest))
        : new Response(new Uint8Array(archive)),
    )
    const ready = await retry.prepareEnterprise(vertex, a, new AbortController().signal)
    expect(await retry.resolve(vertex, a)).toBe(ready.command)
    ready.release()
    await rm(join(ready.command, "..", sibling))
    expect(await retry.resolve(vertex, a)).toBeUndefined()
    const repaired = await retry.prepareEnterprise(vertex, a, new AbortController().signal)
    expect(repaired.command).toBe(ready.command)
    repaired.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

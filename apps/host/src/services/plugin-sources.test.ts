/**
 * 验证插件来源：GitHub 与 git 地址的各种写法、安装对话框里填的内容归到哪一种来源、
 * 安全地解开归档（长路径、跳过链接、拒绝跳出目录），以及下载的上限与 GitHub 的错误说明。
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DownloadError, downloadBytes } from "./plugin-download"
import {
  githubArchiveUrl,
  materializeSource,
  parseGitHubLocation,
  parseGitLocation,
  parsePluginSpec,
} from "./plugin-sources"
import { extractTarGz } from "./plugin-tar"
import { fixedFetcher, tarGz } from "./tar-fixture"

const noGit = async () => {
  throw new Error("git must not run")
}

describe("GitHub and git locations", () => {
  it("reads shorthand, refs, subdirectories and URLs copied from GitHub", () => {
    expect(parseGitHubLocation("acme/tools")).toEqual({ owner: "acme", repo: "tools" })
    expect(parseGitHubLocation("github:acme/tools#v1.2.0")).toEqual({
      owner: "acme",
      repo: "tools",
      ref: "v1.2.0",
    })
    expect(parseGitHubLocation("acme/tools/plugins/clock@main")).toEqual({
      owner: "acme",
      repo: "tools",
      ref: "main",
      path: "plugins/clock",
    })
    expect(parseGitHubLocation("https://github.com/acme/tools.git")).toEqual({
      owner: "acme",
      repo: "tools",
    })
    expect(parseGitHubLocation("https://github.com/acme/tools/tree/feat-x/packages/clock")).toEqual(
      { owner: "acme", repo: "tools", ref: "feat-x", path: "packages/clock" },
    )
    expect(parseGitHubLocation("https://github.com/acme/tools/releases/tag/v2")).toEqual({
      owner: "acme",
      repo: "tools",
      ref: "v2",
    })
  })

  it("refuses things that are not GitHub repositories", () => {
    for (const value of [
      "pigcode-clock",
      "@acme/pigcode-clock",
      "./plugins/clock",
      "/abs/path",
      "https://gitlab.com/acme/tools",
      "http://github.com/acme/tools",
      "acme/../etc",
      "acme/tools#../../x",
      "https://github.com/acme/tools/issues/1",
    ]) {
      expect(parseGitHubLocation(value), value).toBeNull()
    }
  })

  it("reads git addresses for the system git", () => {
    expect(parseGitLocation("git@github.com:acme/private.git#main")).toEqual({
      url: "git@github.com:acme/private.git",
      ref: "main",
    })
    expect(parseGitLocation("git+https://git.example.com/team/tools.git")).toEqual({
      url: "https://git.example.com/team/tools.git",
    })
    expect(parseGitLocation("ssh://git@example.com/tools")).toEqual({
      url: "ssh://git@example.com/tools",
    })
    expect(parseGitLocation("https://example.com/tools")).toBeNull()
  })

  it("sorts install specs into local, npm, GitHub, git and archive sources", () => {
    expect(parsePluginSpec("/tmp/plugin")).toEqual({ kind: "local", path: "/tmp/plugin" })
    expect(parsePluginSpec("file:./plugin")).toEqual({ kind: "local", path: "./plugin" })
    expect(parsePluginSpec("/tmp/plugin.tgz")).toEqual({ kind: "npm", spec: "/tmp/plugin.tgz" })
    expect(parsePluginSpec("pigcode-clock@1.0.0")).toEqual({
      kind: "npm",
      spec: "pigcode-clock@1.0.0",
    })
    expect(parsePluginSpec("@acme/pigcode-clock")).toEqual({
      kind: "npm",
      spec: "@acme/pigcode-clock",
    })
    expect(parsePluginSpec("acme/clock#v1")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "clock",
      ref: "v1",
    })
    expect(parsePluginSpec("git@github.com:acme/clock.git")).toEqual({
      kind: "git",
      url: "git@github.com:acme/clock.git",
    })
    expect(parsePluginSpec("https://example.com/clock-1.0.0.tgz")).toEqual({
      kind: "archive",
      url: "https://example.com/clock-1.0.0.tgz",
    })
    expect(() => parsePluginSpec("https://example.com/clock")).toThrow(/PLUGIN_SOURCE_UNSUPPORTED/)
  })

  it("asks the GitHub API for the default branch or the given ref", () => {
    expect(githubArchiveUrl({ owner: "acme", repo: "tools" })).toBe(
      "https://api.github.com/repos/acme/tools/tarball",
    )
    expect(githubArchiveUrl({ owner: "acme", repo: "tools", ref: "release/1.0" })).toBe(
      "https://api.github.com/repos/acme/tools/tarball/release/1.0",
    )
  })
})

describe("archives", () => {
  it("extracts files and folders, long paths, and drops the leading folder", async () => {
    const dest = await mkdtemp(join(tmpdir(), "pigcode-tar-"))
    const long = `acme-tools-1a2b3c/${"deep/".repeat(30)}file.txt`
    const count = await extractTarGz(
      tarGz([
        { name: "acme-tools-1a2b3c/", type: "dir" },
        { name: "acme-tools-1a2b3c/package.json", content: '{"name":"x"}' },
        { name: long, content: "pax", pax: true },
        {
          name: `acme-tools-1a2b3c/${"gnu/".repeat(30)}long.txt`,
          content: "gnu",
          gnuLongName: true,
        },
        { name: "acme-tools-1a2b3c/link", type: "symlink", linkname: "/etc/passwd" },
      ]),
      dest,
      { strip: 1 },
    )
    expect(count).toBe(3)
    expect(await readFile(join(dest, "package.json"), "utf8")).toBe('{"name":"x"}')
    expect(await readFile(join(dest, ...long.split("/").slice(1)), "utf8")).toBe("pax")
    expect((await readdir(dest)).sort()).toEqual(["deep", "gnu", "package.json"])
  })

  it("refuses archives that write outside the folder", async () => {
    const dest = await mkdtemp(join(tmpdir(), "pigcode-tar-"))
    await expect(
      extractTarGz(tarGz([{ name: "root/../../evil.txt", content: "x" }]), dest),
    ).rejects.toThrow(/PLUGIN_ARCHIVE_UNSAFE/)
    await expect(extractTarGz(tarGz([{ name: "/etc/evil", content: "x" }]), dest)).rejects.toThrow(
      /PLUGIN_ARCHIVE_UNSAFE/,
    )
    await expect(extractTarGz(Buffer.from("not gzip"), dest)).rejects.toThrow(
      /PLUGIN_ARCHIVE_INVALID/,
    )
  })

  it("stops downloads that are too large or fail", async () => {
    const big = fixedFetcher(new Uint8Array(2048))
    await expect(
      downloadBytes("https://example.com/a", {
        fetcher: big.fetcher,
        maxBytes: 1024,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/PLUGIN_DOWNLOAD_TOO_LARGE/)
    const missing = fixedFetcher("nope", 404)
    await expect(
      downloadBytes("https://example.com/a", {
        fetcher: missing.fetcher,
        maxBytes: 1024,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(DownloadError)
  })
})

describe("materializeSource", () => {
  it("downloads a GitHub repository archive and picks the subdirectory", async () => {
    const archive = tarGz([
      { name: "acme-tools-abc/plugins/clock/package.json", content: '{"name":"pigcode-clock"}' },
      { name: "acme-tools-abc/README.md", content: "# tools" },
    ])
    const { fetcher, calls } = fixedFetcher(archive)
    const materialized = await materializeSource(
      { kind: "github", owner: "acme", repo: "tools", ref: "v1", path: "plugins/clock" },
      { fetcher, runGit: noGit, githubToken: "secret" },
    )
    try {
      expect(await readFile(join(materialized.dir, "package.json"), "utf8")).toContain(
        "pigcode-clock",
      )
      expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/tools/tarball/v1")
      expect(calls[0]?.headers.Authorization).toBe("Bearer secret")
    } finally {
      await materialized.cleanup()
    }
  })

  it("explains a missing repository and a rate limit", async () => {
    await expect(
      materializeSource(
        { kind: "github", owner: "acme", repo: "missing" },
        { fetcher: fixedFetcher("", 404).fetcher, runGit: noGit },
      ),
    ).rejects.toThrow(/PLUGIN_GITHUB_NOT_FOUND: acme\/missing/)
    await expect(
      materializeSource(
        { kind: "github", owner: "acme", repo: "tools" },
        { fetcher: fixedFetcher("", 403).fetcher, runGit: noGit },
      ),
    ).rejects.toThrow(/PLUGIN_GITHUB_RATE_LIMITED/)
  })

  it("checks the sha256 of an archive and enters npm's package folder", async () => {
    const archive = tarGz([{ name: "package/package.json", content: '{"name":"pigcode-x"}' }])
    const ok = await materializeSource(
      { kind: "archive", url: "https://example.com/x.tgz" },
      { fetcher: fixedFetcher(archive).fetcher, runGit: noGit },
    )
    try {
      expect(await readFile(join(ok.dir, "package.json"), "utf8")).toContain("pigcode-x")
    } finally {
      await ok.cleanup()
    }
    await expect(
      materializeSource(
        { kind: "archive", url: "https://example.com/x.tgz", sha256: "0".repeat(64) },
        { fetcher: fixedFetcher(archive).fetcher, runGit: noGit },
      ),
    ).rejects.toThrow(/PLUGIN_ARCHIVE_SHA256_MISMATCH/)
  })

  it("clones other git repositories with the system git and drops .git", async () => {
    const calls: string[][] = []
    const materialized = await materializeSource(
      { kind: "git", url: "git@example.com:team/tools.git", ref: "main" },
      {
        fetcher: fixedFetcher("").fetcher,
        runGit: async (args) => {
          calls.push(args)
          const target = args.at(-1)!
          const { mkdir, writeFile } = await import("node:fs/promises")
          await mkdir(join(target, ".git"), { recursive: true })
          await writeFile(join(target, "package.json"), "{}")
        },
      },
    )
    try {
      expect(calls[0]).toEqual([
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "--",
        "git@example.com:team/tools.git",
        join(materialized.dir),
      ])
      expect(await readdir(materialized.dir)).toEqual(["package.json"])
    } finally {
      await materialized.cleanup()
    }
  })
})

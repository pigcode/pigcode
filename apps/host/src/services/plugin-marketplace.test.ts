/**
 * 验证插件市场与按来源安装：本地目录的市场（添加、列出、图标、跳过不合格的条目、安装、更新、删除）、
 * 说得清楚的错误（Claude 市场、其实是插件、找不到目录、重名）、GitHub 上的市场（缓存进 profile，
 * 刷新失败保留上一次）、直接从 GitHub 安装插件，以及 https 上的目录不能用相对路径。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SourceIo } from "./plugin-sources"
import { installFromMarketplace, installPlugin, updatePlugin } from "./plugin-installer"
import { listPlugins, setPluginEnabled } from "./plugin-manager"
import {
  addMarketplace,
  listMarketplaces,
  parseMarketplaceInput,
  refreshMarketplace,
  removeMarketplace,
  setMarketplaceEnabled,
  sourceUrl,
} from "./plugin-marketplace"
import { fixedFetcher, tarGz } from "./tar-fixture"

const noPnpm = async () => {
  throw new Error("pnpm must not run")
}

function io(fetcher: SourceIo["fetcher"] = fixedFetcher("", 500).fetcher): SourceIo {
  return {
    fetcher,
    runGit: async () => {
      throw new Error("git must not run")
    },
  }
}

function pluginManifest(name: string, version = "0.1.0"): string {
  return JSON.stringify({
    name,
    version,
    type: "module",
    pigcode: { apiVersion: 1, kind: "capability", displayName: "Clock", host: "./index.mjs" },
  })
}

async function writePlugin(dir: string, name: string, version = "0.1.0"): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), pluginManifest(name, version))
  await writeFile(join(dir, "index.mjs"), "export function apply() {}\n")
}

/** 一个本地目录市场：plugins/ 下有 clock 插件和市场目录文件。 */
async function localMarketplace(extra: unknown[] = []): Promise<{ root: string; profile: string }> {
  const base = await mkdtemp(join(tmpdir(), "pigcode-market-"))
  const root = join(base, "plugins")
  await writePlugin(join(root, "clock"), "pigcode-clock")
  await writeFile(join(root, "clock", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await mkdir(join(root, ".pigcode-plugin"), { recursive: true })
  await writeFile(
    join(root, ".pigcode-plugin", "marketplace.json"),
    JSON.stringify({
      name: "dev-tools",
      displayName: "开发工具",
      owner: { name: "Alice" },
      plugins: [
        {
          name: "pigcode-clock",
          source: "./clock",
          displayName: "时钟",
          version: "0.1.0",
          category: "productivity",
          icon: "./clock/icon.png",
        },
        { name: "Bad Name", source: "./clock" },
        { name: "pigcode-outside", source: "../../etc" },
        { name: "pigcode-remote", source: { source: "github", repo: "acme/remote", ref: "v1" } },
        ...extra,
      ],
    }),
  )
  return { root, profile: join(base, "profile") }
}

describe("local marketplaces", () => {
  it("adds a folder, lists its valid plugins and turns local icons into data URLs", async () => {
    const { root, profile } = await localMarketplace()
    const summary = await addMarketplace(profile, root, io())
    expect(summary).toMatchObject({
      id: "dev-tools",
      displayName: "开发工具",
      owner: "Alice",
      sourceType: "directory",
      sourceLabel: root,
      error: null,
    })
    expect(summary.plugins.map((plugin) => plugin.name)).toEqual([
      "pigcode-clock",
      "pigcode-remote",
    ])
    expect(summary.plugins[0]?.icon).toBe("data:image/png;base64,iVBORw==")
    expect(summary.plugins[1]?.sourceLabel).toBe("acme/remote#v1")
    expect((await listMarketplaces(profile)).map((item) => item.id)).toEqual(["dev-tools"])
  })

  it("installs a plugin from the marketplace, updates it in place and keeps it disabled", async () => {
    const { root, profile } = await localMarketplace()
    await addMarketplace(profile, root, io())
    const entry = await installFromMarketplace(profile, "dev-tools", "pigcode-clock", noPnpm, io())
    expect(entry.origin).toEqual({
      kind: "marketplace",
      marketplace: "dev-tools",
      plugin: "pigcode-clock",
    })
    let [plugin] = await listPlugins(profile)
    expect(plugin).toMatchObject({ version: "0.1.0", originLabel: "pigcode-clock@dev-tools" })

    await setPluginEnabled(profile, "capability.pigcode-clock", false)
    await writePlugin(join(root, "clock"), "pigcode-clock", "0.2.0")
    await updatePlugin(profile, "capability.pigcode-clock", noPnpm, io())
    ;[plugin] = await listPlugins(profile)
    expect(plugin).toMatchObject({ version: "0.2.0", enabled: false })
  })

  it("refuses a package whose name doesn't match the marketplace entry", async () => {
    const { root, profile } = await localMarketplace([{ name: "pigcode-other", source: "./clock" }])
    await addMarketplace(profile, root, io())
    await expect(
      installFromMarketplace(profile, "dev-tools", "pigcode-other", noPnpm, io()),
    ).rejects.toThrow(/PLUGIN_NAME_MISMATCH/)
  })

  it("keeps installed plugins when the marketplace is removed, but can't update them", async () => {
    const { root, profile } = await localMarketplace()
    await addMarketplace(profile, root, io())
    await installFromMarketplace(profile, "dev-tools", "pigcode-clock", noPnpm, io())
    await removeMarketplace(profile, "dev-tools")
    expect(await listMarketplaces(profile)).toEqual([])
    expect((await listPlugins(profile)).map((plugin) => plugin.name)).toEqual(["pigcode-clock"])
    await expect(updatePlugin(profile, "capability.pigcode-clock", noPnpm, io())).rejects.toThrow(
      /PLUGIN_MARKETPLACE_REMOVED/,
    )
  })

  it("disables a marketplace without touching its plugins, and re-adding turns it back on", async () => {
    const { root, profile } = await localMarketplace()
    await addMarketplace(profile, root, io())
    await installFromMarketplace(profile, "dev-tools", "pigcode-clock", noPnpm, io())

    const disabled = await setMarketplaceEnabled(profile, "dev-tools", false)
    expect(disabled).toMatchObject({ enabled: false, sourcePath: root, sourceUrl: null })
    expect(disabled.plugins.map((plugin) => plugin.name)).toContain("pigcode-clock")
    expect(await listMarketplaces(profile)).toMatchObject([{ id: "dev-tools", enabled: false }])
    expect((await listPlugins(profile)).map((plugin) => plugin.name)).toEqual(["pigcode-clock"])
    await expect(
      installFromMarketplace(profile, "dev-tools", "pigcode-clock", noPnpm, io()),
    ).rejects.toThrow(/MARKETPLACE_DISABLED/)

    await expect(setMarketplaceEnabled(profile, "dev-tools", true)).resolves.toMatchObject({
      enabled: true,
    })
    // 文件里只记停用的市场：启用后这个字段不再出现。
    expect(await readFile(join(profile, "marketplaces.json"), "utf8")).not.toContain("enabled")
    await setMarketplaceEnabled(profile, "dev-tools", false)
    await expect(addMarketplace(profile, root, io())).resolves.toMatchObject({ enabled: true })
    await expect(setMarketplaceEnabled(profile, "missing", true)).rejects.toThrow(
      /MARKETPLACE_UNKNOWN/,
    )
  })

  it("links each kind of source to where it can be opened", () => {
    expect(sourceUrl({ type: "github", owner: "acme", repo: "tools" })).toBe(
      "https://github.com/acme/tools",
    )
    expect(sourceUrl({ type: "github", owner: "acme", repo: "tools", path: "plugins" })).toBe(
      "https://github.com/acme/tools/tree/HEAD/plugins",
    )
    expect(sourceUrl({ type: "git", url: "https://git.example.com/acme/tools.git" })).toBe(
      "https://git.example.com/acme/tools.git",
    )
    expect(sourceUrl({ type: "git", url: "git@github.com:acme/tools.git" })).toBeNull()
    expect(sourceUrl({ type: "directory", path: "/tmp/plugins" })).toBeNull()
  })

  it("says what a folder is when it isn't a Pigcode marketplace", async () => {
    const base = await mkdtemp(join(tmpdir(), "pigcode-market-"))
    const claude = join(base, "claude")
    await mkdir(join(claude, ".claude-plugin"), { recursive: true })
    await writeFile(join(claude, ".claude-plugin", "marketplace.json"), "{}")
    await expect(addMarketplace(join(base, "profile"), claude, io())).rejects.toThrow(
      /MARKETPLACE_CLAUDE_FORMAT/,
    )
    const plugin = join(base, "plugin")
    await writePlugin(plugin, "pigcode-x")
    await expect(addMarketplace(join(base, "profile"), plugin, io())).rejects.toThrow(
      /MARKETPLACE_IS_PLUGIN/,
    )
    const empty = join(base, "empty")
    await mkdir(empty)
    await expect(addMarketplace(join(base, "profile"), empty, io())).rejects.toThrow(
      /MARKETPLACE_NOT_FOUND/,
    )
    await expect(parseMarketplaceInput(join(base, "missing"))).rejects.toThrow(
      /MARKETPLACE_PATH_MISSING/,
    )
  })

  it("refuses a second marketplace with the same name from another place", async () => {
    const first = await localMarketplace()
    const second = await localMarketplace()
    await addMarketplace(first.profile, first.root, io())
    await expect(addMarketplace(first.profile, second.root, io())).rejects.toThrow(
      /MARKETPLACE_EXISTS/,
    )
    // 同一个来源再加一次等于刷新。
    await expect(addMarketplace(first.profile, first.root, io())).resolves.toMatchObject({
      id: "dev-tools",
    })
  })
})

/** GitHub 上的市场仓库：.pigcode-plugin/marketplace.json 和 plugins/clock。 */
function githubMarketplaceArchive(version = "0.1.0"): Buffer {
  return tarGz([
    {
      name: "acme-tools-abc/.pigcode-plugin/marketplace.json",
      content: JSON.stringify({
        name: "acme-tools",
        plugins: [{ name: "pigcode-clock", source: "./plugins/clock", version }],
      }),
    },
    {
      name: "acme-tools-abc/plugins/clock/package.json",
      content: pluginManifest("pigcode-clock", version),
    },
    { name: "acme-tools-abc/plugins/clock/index.mjs", content: "export function apply() {}\n" },
  ])
}

describe("remote marketplaces", () => {
  it("caches a GitHub marketplace in the profile and installs from the cache", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-market-"))
    const { fetcher, calls } = fixedFetcher(githubMarketplaceArchive())
    const summary = await addMarketplace(profile, "https://github.com/acme/tools", io(fetcher))
    expect(summary).toMatchObject({ id: "acme-tools", sourceType: "github" })
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/tools/tarball")
    expect(
      await readFile(
        join(profile, "marketplaces", "acme-tools", "plugins", "clock", "package.json"),
        "utf8",
      ),
    ).toContain("pigcode-clock")
    // 安装从缓存里拿，不再联网。
    await installFromMarketplace(profile, "acme-tools", "pigcode-clock", noPnpm, io())
    expect((await listPlugins(profile)).map((plugin) => plugin.originLabel)).toEqual([
      "pigcode-clock@acme-tools",
    ])
  })

  it("keeps the last good copy when a refresh fails", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-market-"))
    await addMarketplace(
      profile,
      "acme/tools",
      io(fixedFetcher(githubMarketplaceArchive()).fetcher),
    )
    const refreshed = await refreshMarketplace(
      profile,
      "acme-tools",
      io(fixedFetcher("", 404).fetcher),
    )
    expect(refreshed.error).toMatch(/PLUGIN_GITHUB_NOT_FOUND/)
    expect(refreshed.plugins.map((plugin) => plugin.name)).toEqual(["pigcode-clock"])
    const [listed] = await listMarketplaces(profile)
    expect(listed?.error).toMatch(/PLUGIN_GITHUB_NOT_FOUND/)
  })

  it("updates a plugin from a GitHub marketplace after refreshing it", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-market-"))
    await addMarketplace(
      profile,
      "acme/tools",
      io(fixedFetcher(githubMarketplaceArchive()).fetcher),
    )
    await installFromMarketplace(profile, "acme-tools", "pigcode-clock", noPnpm, io())
    await updatePlugin(
      profile,
      "capability.pigcode-clock",
      noPnpm,
      io(fixedFetcher(githubMarketplaceArchive("0.3.0")).fetcher),
    )
    expect((await listPlugins(profile))[0]?.version).toBe("0.3.0")
  })

  it("can't install relative entries from a marketplace.json on the web", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-market-"))
    const manifest = JSON.stringify({
      name: "web-tools",
      plugins: [
        { name: "pigcode-local", source: "./local" },
        { name: "pigcode-gh", source: { source: "github", repo: "acme/gh" } },
      ],
    })
    const summary = await addMarketplace(
      profile,
      "https://example.com/marketplace.json",
      io(fixedFetcher(manifest).fetcher),
    )
    expect(summary.plugins.map((plugin) => plugin.name)).toEqual(["pigcode-local", "pigcode-gh"])
    await expect(
      installFromMarketplace(profile, "web-tools", "pigcode-local", noPnpm, io()),
    ).rejects.toThrow(/MARKETPLACE_ENTRY_UNSUPPORTED/)
  })
})

describe("installing straight from GitHub", () => {
  it("installs a repository that is itself a plugin and remembers where it came from", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-gh-"))
    const archive = tarGz([
      { name: "acme-clock-abc/package.json", content: pluginManifest("pigcode-clock") },
      { name: "acme-clock-abc/index.mjs", content: "export function apply() {}\n" },
    ])
    const entry = await installPlugin(
      profile,
      "acme/clock#v1",
      noPnpm,
      io(fixedFetcher(archive).fetcher),
    )
    expect(entry.origin).toEqual({ kind: "github", owner: "acme", repo: "clock", ref: "v1" })
    expect((await listPlugins(profile))[0]).toMatchObject({
      name: "pigcode-clock",
      originLabel: "acme/clock#v1",
    })
  })

  it("points to「添加插件市场」when the repository is a marketplace", async () => {
    const profile = await mkdtemp(join(tmpdir(), "pigcode-gh-"))
    await expect(
      installPlugin(
        profile,
        "acme/tools",
        noPnpm,
        io(fixedFetcher(githubMarketplaceArchive()).fetcher),
      ),
    ).rejects.toThrow(/PLUGIN_SOURCE_IS_MARKETPLACE/)
  })
})

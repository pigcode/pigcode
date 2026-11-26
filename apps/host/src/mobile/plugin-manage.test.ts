import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobilePluginMethods,
  type MobilePluginListResult,
  type MobilePluginMarketplacesResult,
  type MobilePluginMutationResult,
  type MobilePluginUninstallResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentDriver } from "../agents/driver"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import {
  PluginConflictError,
  type PluginRecord,
  type PluginSummary,
} from "../services/plugin-manager"
import type { MarketplaceEntry, MarketplaceSummary } from "../services/plugin-marketplace"
import type { PluginsService } from "../services/plugins"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobilePluginManage } from "./plugin-manage"
import { MobileSidebarRpc } from "./sidebar-rpc"

const tempDirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const makePlugin = (
  over: Partial<PluginSummary> & { id: string; name: string },
): PluginSummary => ({
  displayName: over.name,
  description: null,
  version: "1.0.0",
  kind: "ui",
  enabled: true,
  builtin: false,
  apiVersion: 1,
  permissions: [],
  provides: [],
  contributes: {},
  conflict: null,
  error: null,
  origin: null,
  originLabel: null,
  ...over,
})

const makeEntry = (over: Partial<MarketplaceEntry> & { name: string }): MarketplaceEntry => ({
  displayName: over.name,
  description: null,
  version: "1.0.0",
  category: null,
  icon: null,
  homepage: null,
  author: null,
  source: { source: "npm", package: over.name },
  sourceLabel: over.name,
  ...over,
})

const makeMarket = (
  over: Partial<MarketplaceSummary> & { id: string; displayName: string },
): MarketplaceSummary => ({
  description: null,
  owner: null,
  sourceType: "url",
  sourceLabel: "https://marketplace.pigcode.dev/marketplace.json",
  sourceUrl: null,
  sourcePath: null,
  enabled: true,
  addedAt: "2026-11-20T00:00:00.000Z",
  lastUpdated: "2026-11-26T00:00:00.000Z",
  error: null,
  plugins: [],
  ...over,
})

async function createPluginFixture(options?: {
  plugins?: PluginSummary[]
  markets?: MarketplaceSummary[]
  conflictIds?: Set<string>
  failInstallName?: string
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pigcode-mp-data-"))
  tempDirs.push(dataDir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(dataDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  const pluginsList = options?.plugins ?? [
    makePlugin({
      id: "agent.@pigcode/agent-builtin",
      name: "@pigcode/agent-builtin",
      displayName: "内置 Agent",
      kind: "agent",
      builtin: true,
      provides: ["agent:builtin"],
      contributes: { secretInternal: true },
    }),
    makePlugin({
      id: "ui.local-demo",
      name: "local-demo",
      displayName: "本地演示",
      version: "0.5.0",
      origin: { kind: "local", path: "/Users/alice/secret/local-demo" },
      originLabel: "/Users/alice/secret/local-demo",
    }),
    makePlugin({
      id: "agent.ext-agent",
      name: "ext-agent",
      displayName: "第三方 Agent",
      kind: "agent",
      provides: ["agent:ext"],
      origin: { kind: "marketplace", marketplace: "pigcode", plugin: "ext-agent" },
      originLabel: "ext-agent@pigcode",
    }),
  ]
  const marketsList = options?.markets ?? [
    makeMarket({
      id: "pigcode",
      official: true,
      displayName: "Pigcode 官方市场",
      sourceUrl: "https://github.com/pigcode/marketplace",
      plugins: [
        makeEntry({
          name: "market-tool",
          displayName: "Market Tool",
          version: "2.0.0",
          icon: "https://cdn.pigcode.dev/icons/tool.png",
          publisherType: "official",
          displayName_i18n: { "zh-CN": "市场工具", en: "Market Tool" },
          description_i18n: { "zh-CN": "市场工具说明" },
        }),
        makeEntry({
          name: "inline-icon-plugin",
          icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          sourceLabel: "/Users/alice/private/plugins/inline",
        }),
      ],
    }),
    makeMarket({
      id: "local-dev",
      displayName: "本地开发市场",
      sourceType: "directory",
      sourceLabel: "/Users/alice/private-market",
      sourcePath: "/Users/alice/private-market",
    }),
    makeMarket({
      id: "disabled-market",
      displayName: "已停用市场",
      sourceType: "github",
      sourceLabel: "acme/disabled",
      enabled: false,
      plugins: [makeEntry({ name: "hidden-plugin" })],
    }),
  ]
  const records = new Map<string, PluginRecord>()
  const conflictIds = options?.conflictIds ?? new Set<string>()
  const find = (id: string) => {
    const item = pluginsList.find((p) => p.id === id)
    if (!item) throw new Error(`plugin not found: ${id}`)
    return item
  }

  const service = {
    list: vi.fn(async () => pluginsList.map((p) => ({ ...p }))),
    records: vi.fn(async () => [...records.values()]),
    record: vi.fn(async (id: string) => {
      const rec = records.get(id)
      if (!rec) throw new Error(`plugin not found: ${id}`)
      return rec
    }),
    installFromMarketplace: vi.fn(async (marketplace: string, name: string) => {
      if (options?.failInstallName === name) {
        throw new Error("PLUGIN_DOWNLOAD_FAILED: HTTP 502 from /Users/alice/cache")
      }
      if (conflictIds.has(name)) throw new PluginConflictError(`conflict for ${name}`)
      const kind = "capability" as const
      const id = `${kind}.${name}`
      pluginsList.push(
        makePlugin({
          id,
          name,
          displayName: "市场工具",
          version: "2.0.0",
          kind,
          provides: [`svc:${name}`],
          origin: { kind: "marketplace", marketplace, plugin: name },
          originLabel: `${name}@${marketplace}`,
        }),
      )
      return { id, name, origin: { kind: "marketplace", marketplace, plugin: name } }
    }),
    update: vi.fn(async (id: string) => {
      const target = find(id)
      if (target.builtin) throw new Error(`PLUGIN_BUILTIN: ${target.name}`)
      target.version = "2.1.0"
      return { id: target.id, name: target.name }
    }),
    marketplaces: vi.fn(async () => marketsList.map((m) => ({ ...m }))),
    refreshMarketplaces: vi.fn(async (id?: string) =>
      id ? marketsList.filter((m) => m.id === id) : marketsList.map((m) => ({ ...m })),
    ),
    uninstall: vi.fn(async (id: string) => {
      const idx = pluginsList.findIndex((p) => p.id === id)
      if (idx === -1) throw new Error(`plugin not found: ${id}`)
      if (pluginsList[idx]!.builtin) throw new Error(`PLUGIN_BUILTIN: ${id}`)
      pluginsList.splice(idx, 1)
    }),
    enable: vi.fn(async (id: string) => {
      if (conflictIds.has(id)) throw new PluginConflictError("svc:dup already occupied")
      find(id).enabled = true
    }),
    disable: vi.fn(async (id: string) => {
      find(id).enabled = false
    }),
  } as unknown as PluginsService

  ctx.provide("plugins", service)
  return { ctx, records, manager: new MobilePluginManage(ctx, () => {}) }
}

const callPlugin = <T>(manager: MobilePluginManage, method: string, params: unknown = {}) =>
  manager.dispatch({ jsonrpc: "2.0", id: randomUUID(), method, params }) as Promise<T>

describe("MobilePluginManage", () => {
  it("sanitizes local paths, strips contributes and data icons, and lists only enabled marketplaces", async () => {
    const { manager } = await createPluginFixture()
    const listed = await callPlugin<MobilePluginListResult>(manager, mobilePluginMethods.list)
    expect(listed.truncated).toBe(false)
    expect(JSON.stringify(listed)).not.toMatch(/\/Users\/alice|secretInternal/)
    expect(listed.plugins.find((p) => p.id === "agent.@pigcode/agent-builtin")).toMatchObject({
      originKind: "builtin",
      canUpdate: false,
    })
    expect(listed.plugins.find((p) => p.id === "ui.local-demo")).toMatchObject({
      originKind: "local",
      originLabel: "本地目录",
      canUpdate: true,
    })

    const markets = await callPlugin<MobilePluginMarketplacesResult>(
      manager,
      mobilePluginMethods.marketplaces,
    )
    expect(markets.marketplaces.map((m) => m.id)).toEqual(["pigcode", "local-dev"])
    expect(JSON.stringify(markets)).not.toMatch(/\/Users\/alice|data:image\/|sourcePath/)
    expect(markets.marketplaces[0]!.plugins[0]?.iconUrl).toBe(
      "https://cdn.pigcode.dev/icons/tool.png",
    )
    expect(markets.marketplaces[0]!.plugins[1]).toMatchObject({
      iconUrl: null,
      sourceLabel: "本地目录",
    })
    expect(markets.marketplaces[1]?.sourceLabel).toBe("本地开发市场")

    const refreshed = await callPlugin<MobilePluginMarketplacesResult>(
      manager,
      mobilePluginMethods.refreshMarketplaces,
      { ifStale: true },
    )
    expect(refreshed.marketplaces.map((m) => m.id)).toEqual(["pigcode", "local-dev"])
  })

  it("handles setEnabled, conflicts, builtin guards, marketplace install/update, and uninstall clearing default agent", async () => {
    const { ctx, records, manager } = await createPluginFixture({
      conflictIds: new Set(["ui.local-demo"]),
      failInstallName: "broken-pkg",
    })
    const disabled = await callPlugin<MobilePluginMutationResult>(
      manager,
      mobilePluginMethods.setEnabled,
      { id: "agent.@pigcode/agent-builtin", enabled: false },
    )
    expect(disabled.plugin.enabled).toBe(false)

    await expect(
      callPlugin(manager, mobilePluginMethods.uninstall, { id: "agent.@pigcode/agent-builtin" }),
    ).rejects.toMatchObject({ code: "PLUGIN_BUILTIN_IMMUTABLE" })
    await expect(
      callPlugin(manager, mobilePluginMethods.update, { id: "agent.@pigcode/agent-builtin" }),
    ).rejects.toMatchObject({ code: "PLUGIN_BUILTIN_IMMUTABLE" })
    await expect(
      callPlugin(manager, mobilePluginMethods.setEnabled, { id: "ui.local-demo", enabled: true }),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFLICT" })

    const installed = await callPlugin<MobilePluginMutationResult>(
      manager,
      mobilePluginMethods.installFromMarketplace,
      { marketplace: "pigcode", name: "market-tool" },
    )
    expect(installed.plugin).toMatchObject({
      id: "capability.market-tool",
      kind: "capability",
      originKind: "marketplace",
      marketplaceId: "pigcode",
      canUpdate: true,
    })

    await expect(
      callPlugin(manager, mobilePluginMethods.installFromMarketplace, {
        marketplace: "disabled-market",
        name: "hidden-plugin",
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" })
    await expect(
      callPlugin(manager, mobilePluginMethods.installFromMarketplace, {
        marketplace: "pigcode",
        name: "broken-pkg",
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_ACTION_FAILED",
      message: expect.stringContaining("PLUGIN_DOWNLOAD_FAILED"),
    })

    const updated = await callPlugin<MobilePluginMutationResult>(
      manager,
      mobilePluginMethods.update,
      { id: "capability.market-tool" },
    )
    expect(updated.plugin.version).toBe("2.1.0")

    ctx.agents.register({
      id: "ext",
      displayName: "Ext",
      features: { streaming: true },
    } as unknown as AgentDriver)
    ctx.agents.setDefaultAgent("ext")
    records.set("agent.ext-agent", {
      id: "agent.ext-agent",
      name: "ext-agent",
      manifest: {
        name: "ext-agent",
        version: "1.0.0",
        pigcode: {
          apiVersion: 1,
          kind: "agent",
          contributes: { agent: { id: "ext", settings: [], customModels: true } },
        },
      },
    } as unknown as PluginRecord)

    const uninstalled = await callPlugin<MobilePluginUninstallResult>(
      manager,
      mobilePluginMethods.uninstall,
      { id: "agent.ext-agent" },
    )
    expect(uninstalled).toEqual({ uninstalled: true })
    expect(ctx.agents.configuredDefaultAgent()).toBeNull()
  })

  it("clips plugin list and marketplace catalog within 48 KiB JSON budget", async () => {
    const { manager } = await createPluginFixture({
      plugins: Array.from({ length: 60 }, (_, i) =>
        makePlugin({
          id: `ui.plugin-${i}`,
          name: `plugin-${i}`,
          description: "d".repeat(1200),
          origin: { kind: "npm", spec: `plugin-${i}` },
          originLabel: `plugin-${i}`,
        }),
      ),
      markets: [
        makeMarket({
          id: "pigcode",
          official: true,
          displayName: "Pigcode",
          plugins: Array.from({ length: 80 }, (_, i) =>
            makeEntry({ name: `mkt-item-${i}`, description: "m".repeat(1000) }),
          ),
        }),
      ],
    })
    const listed = await callPlugin<MobilePluginListResult>(manager, mobilePluginMethods.list)
    expect(listed.truncated).toBe(true)
    expect(listed.plugins.length).toBeLessThan(60)
    expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThanOrEqual(48 * 1024)

    const markets = await callPlugin<MobilePluginMarketplacesResult>(
      manager,
      mobilePluginMethods.marketplaces,
    )
    expect(markets.truncated).toBe(true)
    expect(markets.marketplaces[0]!.plugins.length).toBeGreaterThan(0)
    expect(markets.marketplaces[0]!.plugins.length).toBeLessThan(80)
    expect(Buffer.byteLength(JSON.stringify(markets), "utf8")).toBeLessThanOrEqual(48 * 1024)
  })

  it("gates mobile.plugin.* behind plugins.manage feature and rejects unexposed desktop plugin methods", async () => {
    const { ctx } = await createPluginFixture()
    const devices = new PairedDevices(ctx.settings)
    const deviceKey = Buffer.alloc(32, 12).toString("base64url")
    devices.save({
      publicKey: deviceKey,
      name: "iPhone",
      platform: "ios",
      lastConnectedAt: Date.now(),
    })
    const wire = new MemoryTransport()
    const rpc = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
      computerKey: Buffer.alloc(32, 4),
      computerName: "TestMac",
      deviceKey,
      features: mobileFeatures.filter((f) => f !== "plugins.manage"),
      relayRevision: () => undefined,
    })
    rpc.start()

    for (const method of [
      mobilePluginMethods.list,
      "plugin.install",
      "plugin.installLocal",
      "marketplace.add",
      "marketplace.remove",
    ]) {
      const id = randomUUID()
      wire.client.send({ jsonrpc: "2.0", id, method, params: {} })
      expect(await wire.client.next()).toEqual(
        expect.objectContaining({
          id,
          error: expect.objectContaining({ code: "METHOD_NOT_AVAILABLE" }),
        }),
      )
    }
    rpc.stop()
  })
})

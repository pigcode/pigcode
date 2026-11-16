/** 官方分发目录随应用提供一份快照，刷新只替换校验通过的目录。 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  OFFICIAL_MARKETPLACE_BASE,
  OFFICIAL_MARKETPLACE_BRANCH,
  OFFICIAL_MARKETPLACE_ID,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_REPO,
  OFFICIAL_MARKETPLACE_URL,
} from "../../../../marketplace/catalog-source"
import bundledCatalog from "../../../../marketplace/marketplace.json"
import { writeFileAtomic } from "./atomic-write"
import { downloadBytes, type Fetcher } from "./plugin-download"
import {
  MANIFEST_MAX_BYTES,
  parseManifest,
  type MarketplaceManifest,
} from "./plugin-marketplace-manifest"
import type { MarketplaceSummary } from "./plugin-marketplace"
import type { SourceIo } from "./plugin-sources"

export { OFFICIAL_MARKETPLACE_ID }

const AUTO_REFRESH_INTERVAL = 30 * 60_000
const requests = new Map<string, Promise<MarketplaceSummary>>()

interface CatalogCache {
  catalog: unknown
  checkedAt: number
  lastUpdated: string | null
  error: string | null
}

function cachePath(profileDir: string): string {
  return join(profileDir, "official-marketplace.json")
}

async function validateCatalog(raw: unknown): Promise<MarketplaceManifest> {
  const manifest = await parseManifest(raw, null)
  const declared = (raw as { plugins: unknown[] }).plugins
  if (manifest.name !== OFFICIAL_MARKETPLACE_NAME || manifest.plugins.length !== declared.length) {
    throw new Error("MARKETPLACE_INVALID: invalid Pigcode catalog")
  }
  for (const entry of manifest.plugins) {
    const source = entry.source
    if (
      !entry.publisherType ||
      !entry.version ||
      source.source !== "url" ||
      !source.sha256 ||
      !new URL(source.url).href.startsWith(`${OFFICIAL_MARKETPLACE_BASE}/packages/`)
    ) {
      throw new Error(`MARKETPLACE_INVALID: invalid Pigcode catalog listing for ${entry.name}`)
    }
  }
  return manifest
}

async function readCatalog(
  profileDir: string,
): Promise<{ cache: CatalogCache; manifest: MarketplaceManifest }> {
  try {
    const cache = JSON.parse(await readFile(cachePath(profileDir), "utf8")) as CatalogCache
    const manifest = await validateCatalog(cache.catalog)
    return { cache, manifest }
  } catch {
    const cache = { catalog: bundledCatalog, checkedAt: 0, lastUpdated: null, error: null }
    return { cache, manifest: await validateCatalog(bundledCatalog) }
  }
}

function summarize(cache: CatalogCache, manifest: MarketplaceManifest): MarketplaceSummary {
  return {
    id: OFFICIAL_MARKETPLACE_ID,
    official: true,
    displayName: manifest.displayName ?? "Pigcode",
    description: manifest.description,
    owner: manifest.owner,
    sourceType: "url",
    sourceLabel: OFFICIAL_MARKETPLACE_URL,
    sourceUrl: `${OFFICIAL_MARKETPLACE_REPO}/tree/${OFFICIAL_MARKETPLACE_BRANCH}`,
    sourcePath: null,
    enabled: true,
    addedAt: "",
    lastUpdated: cache.lastUpdated,
    error: cache.error,
    plugins: manifest.plugins,
  }
}

export async function readOfficialMarketplace(profileDir: string): Promise<MarketplaceSummary> {
  const { cache, manifest } = await readCatalog(profileDir)
  return summarize(cache, manifest)
}

async function refresh(
  profileDir: string,
  io: SourceIo,
  ifStale: boolean,
): Promise<MarketplaceSummary> {
  const previous = await readCatalog(profileDir)
  if (ifStale && Date.now() - previous.cache.checkedAt < AUTO_REFRESH_INTERVAL) {
    return summarize(previous.cache, previous.manifest)
  }
  try {
    const bytes = await downloadBytes(OFFICIAL_MARKETPLACE_URL, {
      fetcher: io.fetcher,
      headers: { "Cache-Control": "no-cache" },
      maxBytes: MANIFEST_MAX_BYTES,
      timeoutMs: 8_000,
    })
    const catalog: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"))
    const manifest = await validateCatalog(catalog)
    const checkedAt = Date.now()
    const cache = {
      catalog,
      checkedAt,
      lastUpdated: new Date(checkedAt).toISOString(),
      error: null,
    }
    await writeFileAtomic(cachePath(profileDir), JSON.stringify(cache))
    return summarize(cache, manifest)
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason)
    const cache = { ...previous.cache, checkedAt: Date.now(), error }
    await writeFileAtomic(cachePath(profileDir), JSON.stringify(cache)).catch(() => undefined)
    return summarize(cache, previous.manifest)
  }
}

/** 自动与手动请求共享同一次网络刷新，目录读写独立于个人市场记录。 */
export async function refreshOfficialMarketplace(
  profileDir: string,
  io: SourceIo,
  ifStale = false,
): Promise<MarketplaceSummary> {
  const active = requests.get(profileDir)
  if (active) return active
  const request = refresh(profileDir, io, ifStale)
  requests.set(profileDir, request)
  try {
    return await request
  } finally {
    if (requests.get(profileDir) === request) requests.delete(profileDir)
  }
}

/** Electron E2E 用真实构建的制品模拟发布目录，普通客户端始终访问官方 HTTPS 地址。 */
export function withMarketplaceFixture(fetcher: Fetcher): Fetcher {
  const fixture = process.env.PIGCODE_E2E === "1" ? process.env.PIGCODE_E2E_CATALOG_DIR : undefined
  if (!fixture) return fetcher
  const base = `${OFFICIAL_MARKETPLACE_BASE}/`
  return async (url, init) => {
    if (!url.startsWith(base)) return fetcher(url, init)
    const relative = url.slice(base.length)
    if (
      relative !== "marketplace.json" &&
      !/^packages\/[a-z0-9][a-z0-9._-]*\.tgz$/u.test(relative)
    ) {
      return new Response(null, { status: 404 })
    }
    return readFile(join(fixture, relative)).then(
      (bytes) => new Response(new Uint8Array(bytes)),
      () => new Response(null, { status: 404 }),
    )
  }
}

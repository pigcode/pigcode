/**
 * 插件市场：一个列出若干插件的目录文件（`.pigcode-plugin/marketplace.json` 或根目录的 `marketplace.json`）。
 * 来源可以是 GitHub 仓库（下载归档，不需要 git）、其他 git 仓库、https 上的 marketplace.json、本地目录或文件。
 * 远程来源添加和刷新时下载一次，缓存在 profile 的 `marketplaces/<id>/` 里；本地来源每次直接读，
 * 改了插件源码刷新一下就能看到。删除市场只删目录和缓存，从它装的插件保留。
 */
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, join, resolve, win32 } from "node:path"
import { writeFileAtomic } from "./atomic-write"
import { downloadBytes } from "./plugin-download"
import {
  MANIFEST_MAX_BYTES,
  parseManifest,
  readJson,
  type MarketplaceEntry,
  type MarketplaceManifest,
} from "./plugin-marketplace-manifest"
import {
  materializeSource,
  parseGitHubLocation,
  parseGitLocation,
  type GitHubLocation,
  type GitLocation,
  type SourceIo,
} from "./plugin-sources"

export {
  entryPluginSource,
  type EntrySource,
  type MarketplaceEntry,
} from "./plugin-marketplace-manifest"

/** 市场从哪里来。 */
export type MarketplaceSource =
  | ({ type: "github" } & GitHubLocation)
  | ({ type: "git" } & GitLocation)
  | { type: "url"; url: string }
  | { type: "directory"; path: string }
  | { type: "file"; path: string }

/** `marketplaces.json` 里的一条记录。 */
export interface MarketplaceRecord {
  id: string
  source: MarketplaceSource
  /** 用户填的原文，界面上显示。 */
  input: string
  addedAt: string
  lastUpdated: string | null
  /** 最近一次刷新失败的原因；成功后清空。 */
  error: string | null
  /** 停用的市场不在插件市场里列出，「全部刷新」跳过它，也不能从它安装；缺省为启用。 */
  enabled?: boolean | undefined
}

/** 插件页看到的一个市场。 */
export interface MarketplaceSummary {
  id: string
  displayName: string
  description: string | null
  owner: string | null
  sourceType: MarketplaceSource["type"]
  sourceLabel: string
  /** 在浏览器里打开来源的地址：GitHub 仓库页、https 上的 git 仓库或目录文件；本地来源为 null。 */
  sourceUrl: string | null
  /** 本地来源的路径，在文件管理器里显示；远程来源为 null。 */
  sourcePath: string | null
  enabled: boolean
  addedAt: string
  lastUpdated: string | null
  error: string | null
  plugins: MarketplaceEntry[]
}

/** 读到的市场：目录文件与相对路径的起点（https 上的目录没有起点），url 来源还带着原始 JSON。 */
interface LoadedMarketplace {
  manifest: MarketplaceManifest
  root: string | null
  raw?: unknown
  cleanup?: (() => Promise<void>) | undefined
}

export const MARKETPLACES_FILE = "marketplaces.json"
const MARKETPLACES_DIR = "marketplaces"
const MANIFEST_PATHS = [join(".pigcode-plugin", "marketplace.json"), "marketplace.json"] as const
/** profile 里的市场列表；文件不存在或读不懂时为空。 */
async function readRecords(profileDir: string): Promise<MarketplaceRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(join(profileDir, MARKETPLACES_FILE), "utf8")) as {
      marketplaces?: MarketplaceRecord[]
    }
    return Array.isArray(parsed.marketplaces) ? parsed.marketplaces : []
  } catch {
    return []
  }
}

async function writeRecords(profileDir: string, records: MarketplaceRecord[]): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  await writeFileAtomic(
    join(profileDir, MARKETPLACES_FILE),
    `${JSON.stringify({ version: 1, marketplaces: records }, null, 2)}\n`,
  )
}

function cacheDir(profileDir: string, id: string): string {
  return join(profileDir, MARKETPLACES_DIR, id)
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

async function pathKind(path: string): Promise<"file" | "directory" | null> {
  const info = await stat(path).catch(() => null)
  return info?.isDirectory() ? "directory" : info?.isFile() ? "file" : null
}

/**
 * 「添加插件市场」里填的内容是哪一种来源：GitHub 仓库（`owner/repo`、网页地址，可带分支和子目录）、
 * git 地址、https 上的 marketplace.json、本地目录或 .json 文件（绝对路径或 `~/`）。
 */
export async function parseMarketplaceInput(input: string): Promise<MarketplaceSource> {
  const value = input.trim()
  if (!value) throw new Error("MARKETPLACE_SOURCE_EMPTY")
  const local = expandHome(value)
  if (win32.isAbsolute(local) || value.startsWith("~")) {
    const kind = await pathKind(local)
    if (kind === "directory") return { type: "directory", path: resolve(local) }
    if (kind === "file") {
      if (extname(local).toLowerCase() !== ".json")
        throw new Error(`MARKETPLACE_FILE_NOT_JSON: ${value}`)
      return { type: "file", path: resolve(local) }
    }
    throw new Error(`MARKETPLACE_PATH_MISSING: ${value}`)
  }
  if (!value.startsWith("git+") && !value.startsWith("git@")) {
    const github = parseGitHubLocation(value)
    if (github) return { type: "github", ...github }
  }
  const git = parseGitLocation(value)
  if (git) return { type: "git", ...git }
  if (/^https:\/\//i.test(value) && new URL(value).pathname.toLowerCase().endsWith(".json")) {
    return { type: "url", url: value }
  }
  throw new Error(`MARKETPLACE_SOURCE_UNSUPPORTED: ${value}`)
}

/** 在目录里找市场目录文件；找不到时说清楚这个目录是什么。 */
async function readManifestIn(root: string): Promise<LoadedMarketplace> {
  for (const relative of MANIFEST_PATHS) {
    const path = join(root, relative)
    if ((await pathKind(path)) === "file") {
      return { manifest: await parseManifest(await readJson(path), root), root }
    }
  }
  if ((await pathKind(join(root, ".claude-plugin", "marketplace.json"))) === "file") {
    throw new Error("MARKETPLACE_CLAUDE_FORMAT: this is a Claude Code plugin marketplace")
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      pigcode?: unknown
    }
    if (pkg.pigcode) throw new Error("MARKETPLACE_IS_PLUGIN: this is a plugin, not a marketplace")
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MARKETPLACE_IS_PLUGIN")) throw error
  }
  throw new Error("MARKETPLACE_NOT_FOUND: no marketplace.json in this source")
}

/** .json 文件的起点：在 `.pigcode-plugin/` 里时是它的上一级，否则是文件所在目录。 */
function fileRoot(path: string): string {
  const dir = dirname(path)
  return basename(dir) === ".pigcode-plugin" ? dirname(dir) : dir
}

/** 从来源读出市场；远程来源先下载到临时目录。 */
async function loadFromSource(source: MarketplaceSource, io: SourceIo): Promise<LoadedMarketplace> {
  switch (source.type) {
    case "directory":
      return readManifestIn(source.path)
    case "file":
      return {
        manifest: await parseManifest(await readJson(source.path), fileRoot(source.path)),
        root: fileRoot(source.path),
      }
    case "url": {
      const bytes = await downloadBytes(source.url, {
        fetcher: io.fetcher,
        maxBytes: MANIFEST_MAX_BYTES,
        timeoutMs: 60_000,
      })
      let raw: unknown
      try {
        raw = JSON.parse(Buffer.from(bytes).toString("utf8"))
      } catch (error) {
        throw new Error(
          `MARKETPLACE_INVALID: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return { manifest: await parseManifest(raw, null), root: null, raw }
    }
    case "github":
    case "git": {
      const materialized = await materializeSource(
        source.type === "github"
          ? {
              kind: "github",
              owner: source.owner,
              repo: source.repo,
              ref: source.ref,
              path: source.path,
            }
          : { kind: "git", url: source.url, ref: source.ref, path: source.path },
        io,
      )
      try {
        return { ...(await readManifestIn(materialized.dir)), cleanup: materialized.cleanup }
      } catch (error) {
        await materialized.cleanup()
        throw error
      }
    }
  }
}

/** 远程来源的内容放进 profile 的缓存；本地来源不缓存。 */
async function persistCache(
  profileDir: string,
  id: string,
  source: MarketplaceSource,
  loaded: LoadedMarketplace,
): Promise<void> {
  if (source.type === "directory" || source.type === "file") return
  const target = cacheDir(profileDir, id)
  // 先在旁边准备好再换上：中途失败时上一次的缓存还在。
  const staging = `${target}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  if (source.type === "url") {
    await writeFileAtomic(join(staging, "marketplace.json"), JSON.stringify(loaded.raw))
  } else if (loaded.root) {
    await cp(loaded.root, staging, { recursive: true })
  }
  await rm(target, { recursive: true, force: true })
  await rename(staging, target)
}

/** 当前的目录：远程来源读缓存，本地来源直接读。 */
async function readCurrent(
  profileDir: string,
  record: MarketplaceRecord,
): Promise<LoadedMarketplace> {
  const source = record.source
  if (source.type === "directory" || source.type === "file")
    return loadFromSource(source, noNetwork)
  const dir = cacheDir(profileDir, record.id)
  if (source.type === "url") {
    return {
      manifest: await parseManifest(await readJson(join(dir, "marketplace.json")), null),
      root: null,
    }
  }
  return readManifestIn(dir)
}

/** 读本地来源用不到网络与 git。 */
const noNetwork: SourceIo = {
  fetcher: () => Promise.reject(new Error("network is not used for local marketplaces")),
  runGit: () => Promise.reject(new Error("git is not used for local marketplaces")),
}

/** 来源在浏览器里的地址；本地来源和 ssh 形式的 git 地址没有。 */
export function sourceUrl(source: MarketplaceSource): string | null {
  switch (source.type) {
    case "github": {
      const repo = `https://github.com/${source.owner}/${source.repo}`
      if (!source.ref && !source.path) return repo
      return `${repo}/tree/${source.ref ?? "HEAD"}${source.path ? `/${source.path}` : ""}`
    }
    case "git":
      return /^https:\/\//i.test(source.url) ? source.url : null
    case "url":
      return source.url
    case "directory":
    case "file":
      return null
  }
}

function summarize(
  record: MarketplaceRecord,
  manifest: MarketplaceManifest | null,
): MarketplaceSummary {
  const source = record.source
  return {
    id: record.id,
    displayName: manifest?.displayName ?? record.id,
    description: manifest?.description ?? null,
    owner: manifest?.owner ?? null,
    sourceType: source.type,
    sourceLabel: record.input,
    sourceUrl: sourceUrl(source),
    sourcePath: source.type === "directory" || source.type === "file" ? source.path : null,
    enabled: record.enabled !== false,
    addedAt: record.addedAt,
    lastUpdated: record.lastUpdated,
    error: record.error,
    plugins: manifest?.plugins ?? [],
  }
}

function sameSource(left: MarketplaceSource, right: MarketplaceSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** 添加一个市场；同名市场来自别的来源时拒绝，同一来源再加一次等于刷新。 */
export async function addMarketplace(
  profileDir: string,
  input: string,
  io: SourceIo,
): Promise<MarketplaceSummary> {
  const source = await parseMarketplaceInput(input)
  const loaded = await loadFromSource(source, io)
  try {
    const records = await readRecords(profileDir)
    const id = loaded.manifest.name
    const existing = records.find((record) => record.id === id)
    if (existing && !sameSource(existing.source, source)) {
      throw new Error(`MARKETPLACE_EXISTS: ${id} is already added from ${existing.input}`)
    }
    await persistCache(profileDir, id, source, loaded)
    const now = new Date().toISOString()
    // 再添加一次同一来源等于刷新，同时重新启用它。
    const record: MarketplaceRecord = {
      id,
      source,
      input: input.trim(),
      addedAt: existing?.addedAt ?? now,
      lastUpdated: now,
      error: null,
    }
    await writeRecords(profileDir, [...records.filter((item) => item.id !== id), record])
    return summarize(record, loaded.manifest)
  } finally {
    await loaded.cleanup?.()
  }
}

/** 刷新一个市场；失败时保留上一次的内容，原因记在 error 里。 */
export async function refreshMarketplace(
  profileDir: string,
  id: string,
  io: SourceIo,
): Promise<MarketplaceSummary> {
  const records = await readRecords(profileDir)
  const record = records.find((item) => item.id === id)
  if (!record) throw new Error(`MARKETPLACE_UNKNOWN: ${id}`)
  let manifest: MarketplaceManifest | null = null
  let next: MarketplaceRecord
  try {
    const loaded = await loadFromSource(record.source, io)
    try {
      if (loaded.manifest.name !== id) {
        throw new Error(`MARKETPLACE_RENAMED: the source now declares ${loaded.manifest.name}`)
      }
      await persistCache(profileDir, id, record.source, loaded)
      manifest = loaded.manifest
      next = { ...record, lastUpdated: new Date().toISOString(), error: null }
    } finally {
      await loaded.cleanup?.()
    }
  } catch (error) {
    next = { ...record, error: error instanceof Error ? error.message : String(error) }
    manifest = await readCurrent(profileDir, record).then(
      (loaded) => loaded.manifest,
      () => null,
    )
  }
  await writeRecords(
    profileDir,
    records.map((item) => (item.id === id ? next : item)),
  )
  return summarize(next, manifest)
}

/** 启用或停用市场；停用只是不再列出、不再刷新，记录、缓存和从它装的插件都保留。 */
export async function setMarketplaceEnabled(
  profileDir: string,
  id: string,
  enabled: boolean,
): Promise<MarketplaceSummary> {
  const records = await readRecords(profileDir)
  const record = records.find((item) => item.id === id)
  if (!record) throw new Error(`MARKETPLACE_UNKNOWN: ${id}`)
  // 启用时不写这个字段，文件里只记停用的市场。
  const next: MarketplaceRecord = { ...record, enabled: enabled ? undefined : false }
  await writeRecords(
    profileDir,
    records.map((item) => (item.id === id ? next : item)),
  )
  const manifest = await readCurrent(profileDir, next).then(
    (loaded) => loaded.manifest,
    () => null,
  )
  return summarize(next, manifest)
}

/** 删除市场：只删记录和缓存，从它装的插件保留。 */
export async function removeMarketplace(profileDir: string, id: string): Promise<void> {
  const records = await readRecords(profileDir)
  if (!records.some((record) => record.id === id)) throw new Error(`MARKETPLACE_UNKNOWN: ${id}`)
  await writeRecords(
    profileDir,
    records.filter((record) => record.id !== id),
  )
  await rm(cacheDir(profileDir, id), { recursive: true, force: true })
}

/** 全部市场；某个市场读不出来时带着原因列出，其余照常。 */
export async function listMarketplaces(profileDir: string): Promise<MarketplaceSummary[]> {
  const summaries: MarketplaceSummary[] = []
  for (const record of await readRecords(profileDir)) {
    try {
      summaries.push(summarize(record, (await readCurrent(profileDir, record)).manifest))
    } catch (error) {
      summaries.push({
        ...summarize(record, null),
        error: record.error ?? (error instanceof Error ? error.message : String(error)),
      })
    }
  }
  return summaries
}

/** 安装时找到市场里的条目，以及相对路径的起点。 */
export async function resolveMarketplaceEntry(
  profileDir: string,
  id: string,
  name: string,
): Promise<{ entry: MarketplaceEntry; root: string | null }> {
  const record = (await readRecords(profileDir)).find((item) => item.id === id)
  if (!record) throw new Error(`MARKETPLACE_UNKNOWN: ${id}`)
  if (record.enabled === false) throw new Error(`MARKETPLACE_DISABLED: ${id}`)
  const loaded = await readCurrent(profileDir, record)
  const entry = loaded.manifest.plugins.find((plugin) => plugin.name === name)
  if (!entry) throw new Error(`MARKETPLACE_ENTRY_UNKNOWN: ${name} is not in ${id}`)
  return { entry, root: loaded.root }
}

/** 市场的来源类型；更新从市场装的插件前，远程市场先刷新一次。 */
export async function marketplaceSourceType(
  profileDir: string,
  id: string,
): Promise<MarketplaceSource["type"] | null> {
  return (await readRecords(profileDir)).find((record) => record.id === id)?.source.type ?? null
}

/**
 * 插件市场的目录文件 marketplace.json：校验并整理成插件页能直接用的样子。格式不对的条目跳过，
 * 同名条目只留第一个；图片可以是 https 地址，也可以是市场里的相对路径（转成 data URL，渲染进程不读本地文件）。
 */
import { readFile, stat } from "node:fs/promises"
import { basename, extname, resolve, sep } from "node:path"
import { isTarballPath } from "./plugin-npm"
import {
  describeSource,
  parseGitHubLocation,
  parseGitLocation,
  validSha256,
  type PluginSource,
} from "./plugin-sources"

/** 市场里一个插件的安装来源（marketplace.json 里 `plugins[].source`）。 */
export type EntrySource =
  | { source: "path"; path: string }
  | { source: "github"; repo: string; ref?: string | undefined; path?: string | undefined }
  | { source: "git"; url: string; ref?: string | undefined; path?: string | undefined }
  | { source: "npm"; package: string; version?: string | undefined }
  | { source: "url"; url: string; sha256?: string | undefined }

/** 市场里的一个插件。 */
export interface MarketplaceEntry {
  /** 插件的包名；装好后的 package.json 必须同名。 */
  name: string
  displayName: string | null
  description: string | null
  version: string | null
  category: string | null
  /** https 地址，或者市场里的图片（转成 data URL）。 */
  icon: string | null
  homepage: string | null
  author: string | null
  source: EntrySource
  /** 来源的一句话说明。 */
  sourceLabel: string
}

export interface MarketplaceManifest {
  name: string
  displayName: string | null
  description: string | null
  owner: string | null
  plugins: MarketplaceEntry[]
}

export const MARKETPLACE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024
const ICON_MAX_BYTES = 256 * 1024
const ICON_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null
}

function httpsUrl(value: unknown): string | null {
  const candidate = text(value, 2000)
  if (!candidate) return null
  try {
    return new URL(candidate).protocol === "https:" ? candidate : null
  } catch {
    return null
  }
}

function personName(value: unknown): string | null {
  if (typeof value === "string") return text(value, 120)
  if (value && typeof value === "object") return text((value as { name?: unknown }).name, 120)
  return null
}

/** 相对路径：不能是绝对路径，不能有 `..`。 */
function relativePath(value: unknown): string | null {
  const path = text(value, 500)
  if (!path || path.includes(":") || path.startsWith("/") || path.startsWith("\\")) return null
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  return parts.length > 0 && !parts.includes("..") ? parts.join("/") : null
}

function parseEntrySource(raw: unknown): EntrySource | null {
  if (typeof raw === "string") {
    const path = relativePath(raw)
    return path ? { source: "path", path } : null
  }
  if (!raw || typeof raw !== "object") return null
  const source = raw as Record<string, unknown>
  const ref = text(source.ref, 200) ?? undefined
  const path = source.path === undefined ? undefined : (relativePath(source.path) ?? null)
  if (path === null) return null
  switch (source.source) {
    case "path":
    case "directory": {
      const dir = relativePath(source.path)
      return dir ? { source: "path", path: dir } : null
    }
    case "github": {
      const repo = text(source.repo, 200)
      const location = repo ? parseGitHubLocation(repo) : null
      if (!location || location.path || location.ref) return null
      return { source: "github", repo: `${location.owner}/${location.repo}`, ref, path }
    }
    case "git": {
      const url = text(source.url, 2000)
      return url && parseGitLocation(url) ? { source: "git", url, ref, path } : null
    }
    case "npm": {
      const name = text(source.package, 214)
      if (!name || !PACKAGE_NAME.test(name)) return null
      return { source: "npm", package: name, version: text(source.version, 100) ?? undefined }
    }
    case "url": {
      const url = httpsUrl(source.url)
      if (!url || !isTarballPath(new URL(url).pathname)) return null
      return {
        source: "url",
        url,
        sha256: validSha256(source.sha256) ? source.sha256.toLowerCase() : undefined,
      }
    }
    default:
      return null
  }
}

/** 条目来源换成安装用的插件来源；https 上的目录没有起点，不能用相对路径。 */
export function entryPluginSource(entry: MarketplaceEntry, root: string | null): PluginSource {
  const source = entry.source
  switch (source.source) {
    case "path": {
      if (!root)
        throw new Error(`MARKETPLACE_ENTRY_UNSUPPORTED: ${entry.name} uses a relative path`)
      const dir = resolve(root, source.path)
      if (dir !== root && !dir.startsWith(root + sep)) {
        throw new Error(
          `MARKETPLACE_ENTRY_UNSUPPORTED: ${entry.name} points outside the marketplace`,
        )
      }
      return { kind: "local", path: dir }
    }
    case "github": {
      const [owner = "", repo = ""] = source.repo.split("/")
      return { kind: "github", owner, repo, ref: source.ref, path: source.path }
    }
    case "git":
      return { kind: "git", url: source.url, ref: source.ref, path: source.path }
    case "npm":
      return {
        kind: "npm",
        spec: source.version ? `${source.package}@${source.version}` : source.package,
      }
    case "url":
      return { kind: "archive", url: source.url, sha256: source.sha256 }
  }
}

/** 市场里的图片转成 data URL（渲染进程不能读本地文件）；太大或格式不认识时不要。 */
async function iconOf(raw: unknown, root: string | null): Promise<string | null> {
  const url = httpsUrl(raw)
  if (url) return url
  const path = relativePath(raw)
  const type = path ? ICON_TYPES[extname(path).toLowerCase()] : undefined
  if (!path || !root || !type) return null
  const file = resolve(root, path)
  if (!file.startsWith(root + sep)) return null
  try {
    const data = await readFile(file)
    return data.byteLength <= ICON_MAX_BYTES
      ? `data:${type};base64,${data.toString("base64")}`
      : null
  } catch {
    return null
  }
}

/** 校验并整理目录文件；格式不对的条目跳过，同名条目只留第一个。 */
export async function parseManifest(
  raw: unknown,
  root: string | null,
): Promise<MarketplaceManifest> {
  if (!raw || typeof raw !== "object") throw new Error("MARKETPLACE_INVALID: not a JSON object")
  const value = raw as Record<string, unknown>
  const name = text(value.name, 64)
  if (!name || !MARKETPLACE_NAME.test(name)) {
    throw new Error("MARKETPLACE_INVALID: name must be lowercase letters, digits, '.', '_' or '-'")
  }
  if (!Array.isArray(value.plugins))
    throw new Error("MARKETPLACE_INVALID: plugins must be an array")
  const plugins: MarketplaceEntry[] = []
  for (const item of value.plugins.slice(0, 500)) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    const entryName = text(entry.name, 214)
    const source = parseEntrySource(entry.source)
    if (!entryName || !PACKAGE_NAME.test(entryName) || !source) continue
    if (plugins.some((plugin) => plugin.name === entryName)) continue
    const parsed: MarketplaceEntry = {
      name: entryName,
      displayName: text(entry.displayName, 120),
      description: text(entry.description, 1000),
      version: text(entry.version, 64),
      category: text(entry.category, 64),
      icon: await iconOf(entry.icon, root),
      homepage: httpsUrl(entry.homepage),
      author: personName(entry.author),
      source,
      sourceLabel: "",
    }
    parsed.sourceLabel =
      source.source === "path"
        ? source.path
        : describeSource(entryPluginSource(parsed, root ?? "/"))
    plugins.push(parsed)
  }
  return {
    name,
    displayName: text(value.displayName, 120),
    description: text(value.description, 1000),
    owner: personName(value.owner),
    plugins,
  }
}

export async function readJson(path: string): Promise<unknown> {
  const info = await stat(path)
  if (info.size > MANIFEST_MAX_BYTES)
    throw new Error(`MARKETPLACE_INVALID: ${basename(path)} is too large`)
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(
      `MARKETPLACE_INVALID: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 插件与插件市场的来源。GitHub 仓库按 tar.gz 归档下载（不需要系统 git），可以指定分支、标签或提交，
 * 以及仓库里的子目录；其他 git 仓库（私有仓库、SSH、自建服务）用系统 git 浅克隆；
 * https 上的 tar.gz 直接下载，给了 sha256 就校验。下载的内容解到临时目录，用完删掉。
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep, win32 } from "node:path"
import { promisify } from "node:util"
import { DownloadError, downloadBytes, type Fetcher } from "./plugin-download"
import { isTarballPath } from "./plugin-npm"
import { extractTarGz } from "./plugin-tar"

/** GitHub 上的一个位置：仓库，可选的分支 / 标签 / 提交，可选的子目录。 */
export interface GitHubLocation {
  owner: string
  repo: string
  ref?: string | undefined
  path?: string | undefined
}

/** 其他 git 仓库：交给系统 git 浅克隆。 */
export interface GitLocation {
  url: string
  ref?: string | undefined
  path?: string | undefined
}

/** 一个插件从哪里来。 */
export type PluginSource =
  | { kind: "local"; path: string }
  | { kind: "npm"; spec: string }
  | ({ kind: "github" } & GitHubLocation)
  | ({ kind: "git" } & GitLocation)
  | { kind: "archive"; url: string; sha256?: string | undefined }

/** 需要先下载到临时目录的来源。 */
export type RemoteSource = Extract<PluginSource, { kind: "github" | "git" | "archive" }>

/** 运行 git；测试注入替身。 */
export type GitRunner = (args: string[]) => Promise<void>

/** 下载与克隆用到的外部能力。 */
export interface SourceIo {
  fetcher: Fetcher
  runGit: GitRunner
  /** GitHub 令牌（环境变量 GITHUB_TOKEN / GH_TOKEN）；有它时访问私有仓库、不受匿名限流。 */
  githubToken?: string | undefined
}

/** 归档最大 50 MB，解开后最大 200 MB；下载两分钟超时。 */
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 180_000

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const REF = /^[A-Za-z0-9._/+-]{1,200}$/
const SHA256 = /^[a-f0-9]{64}$/

const execFileAsync = promisify(execFile)

/** 默认的 git：不弹凭据输入，超时就放弃。 */
export const defaultGitRunner: GitRunner = async (args) => {
  try {
    await execFileAsync("git", args, {
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("PLUGIN_GIT_UNAVAILABLE: git is not installed or not on PATH")
    }
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`PLUGIN_GIT_FAILED: ${stderr || (error as Error).message}`)
  }
}

/** 环境变量里的 GitHub 令牌。 */
export function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined
}

/** 子目录：每一段都不能是空、`.` 或 `..`。 */
function safeSubpath(path: string | undefined): string | undefined | null {
  if (path === undefined || path === "") return undefined
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length === 0) return undefined
  return parts.some((part) => part === "." || part === "..") ? null : parts.join("/")
}

function validRef(ref: string | undefined): boolean {
  return (
    ref === undefined ||
    (REF.test(ref) && !ref.includes("..") && !ref.startsWith("/") && !ref.endsWith("/"))
  )
}

function checkedGitHub(location: GitHubLocation): GitHubLocation | null {
  const path = safeSubpath(location.path)
  if (path === null || !OWNER.test(location.owner) || !REPO.test(location.repo)) return null
  if (location.repo === "." || location.repo === ".." || !validRef(location.ref)) return null
  return {
    owner: location.owner,
    repo: location.repo,
    ...(location.ref ? { ref: location.ref } : {}),
    ...(path ? { path } : {}),
  }
}

/**
 * 认得出的 GitHub 写法：`owner/repo`、`owner/repo/子目录`、`owner/repo#ref`、`github:owner/repo`、
 * `https://github.com/owner/repo`，以及网页上复制来的 `/tree/<ref>/<子目录>`、`/releases/tag/<tag>`。
 */
export function parseGitHubLocation(input: string): GitHubLocation | null {
  let value = input.trim()
  if (value.startsWith("github:")) value = value.slice("github:".length)
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    const host = url.hostname.toLowerCase()
    if (url.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com"))
      return null
    if (url.username || url.password || url.search) return null
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const [owner = "", rawRepo = "", kind, ...rest] = segments
    let ref = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined
    let path: string | undefined
    if (kind === "tree" || kind === "blob") {
      ref = rest[0]
      path = rest.slice(1).join("/") || undefined
    } else if (kind === "releases" && rest[0] === "tag") ref = rest[1]
    else if (kind === "commit") ref = rest[0]
    else if (kind !== undefined) return null
    return checkedGitHub({ owner, repo: rawRepo.replace(/\.git$/, ""), ref, path })
  }
  if (
    /[:\\\s]/.test(value) ||
    value.startsWith("@") ||
    value.startsWith(".") ||
    value.startsWith("/")
  ) {
    return null
  }
  let ref: string | undefined
  const hash = value.indexOf("#")
  if (hash !== -1) {
    ref = value.slice(hash + 1) || undefined
    value = value.slice(0, hash)
  } else {
    const at = value.lastIndexOf("@")
    if (at > 0) {
      ref = value.slice(at + 1) || undefined
      value = value.slice(0, at)
    }
  }
  const segments = value.split("/")
  if (segments.length < 2 || segments.some((segment) => segment === "")) return null
  const [owner = "", repo = "", ...rest] = segments
  return checkedGitHub({
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref,
    path: rest.join("/") || undefined,
  })
}

/** 认得出的 git 地址：`git+https://…`、`git@host:path`、`ssh://`、`git://`，以及以 .git 结尾的 https 地址。 */
export function parseGitLocation(input: string): GitLocation | null {
  let value = input.trim()
  let ref: string | undefined
  const hash = value.indexOf("#")
  if (hash !== -1) {
    ref = value.slice(hash + 1) || undefined
    value = value.slice(0, hash)
  }
  if (value.startsWith("git+")) value = value.slice("git+".length)
  const scp = /^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)
  let url: URL | null = null
  try {
    url = scp ? null : new URL(value)
  } catch {
    return null
  }
  const ok =
    scp ||
    (url !== null &&
      (url.protocol === "ssh:" ||
        url.protocol === "git:" ||
        (url.protocol === "https:" && url.pathname.endsWith(".git"))))
  if (!ok || !validRef(ref)) return null
  return { url: value, ...(ref ? { ref } : {}) }
}

/**
 * 安装对话框里填的内容是哪一种来源：本地目录（绝对路径、`./`、`file:`）、git 仓库、GitHub 仓库、
 * https 上的 tar.gz，其余按 npm 包（包名、版本或本地 tarball，交给 pnpm）。
 */
export function parsePluginSpec(spec: string): PluginSource {
  const value = spec.trim()
  const localPath = value.startsWith("file:") ? value.slice("file:".length) : value
  const isLocal = value.startsWith(".") || value.startsWith("file:") || win32.isAbsolute(value)
  if (isLocal)
    return isTarballPath(localPath)
      ? { kind: "npm", spec: value }
      : { kind: "local", path: localPath }
  const github = parseGitHubLocation(value)
  if (github && !value.startsWith("git+") && !value.startsWith("git@"))
    return { kind: "github", ...github }
  const git = parseGitLocation(value)
  if (git) return { kind: "git", ...git }
  if (/^https:\/\//i.test(value)) {
    if (isTarballPath(new URL(value).pathname)) return { kind: "archive", url: value }
    throw new Error(`PLUGIN_SOURCE_UNSUPPORTED: ${value}`)
  }
  if (/^https?:\/\//i.test(value)) throw new Error(`PLUGIN_SOURCE_UNSUPPORTED: ${value}`)
  return { kind: "npm", spec: value }
}

/** 一句话说清来源，插件详情与市场列表里显示。 */
export function describeSource(source: PluginSource): string {
  switch (source.kind) {
    case "local":
      return source.path
    case "npm":
      return source.spec
    case "github":
      return `${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}${source.ref ? `#${source.ref}` : ""}`
    case "git":
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`
    case "archive":
      return source.url
  }
}

/** GitHub 归档的下载地址：不给 ref 时是默认分支。 */
export function githubArchiveUrl(location: GitHubLocation): string {
  const ref = location.ref ? `/${location.ref.split("/").map(encodeURIComponent).join("/")}` : ""
  return `https://api.github.com/repos/${location.owner}/${location.repo}/tarball${ref}`
}

/** 把 GitHub 的 HTTP 错误换成说得清楚的原因。 */
function githubError(error: unknown, location: GitHubLocation): Error {
  if (!(error instanceof DownloadError))
    return error instanceof Error ? error : new Error(String(error))
  const name = `${location.owner}/${location.repo}${location.ref ? `#${location.ref}` : ""}`
  if (error.status === 404) return new Error(`PLUGIN_GITHUB_NOT_FOUND: ${name}`)
  if (error.status === 403 || error.status === 429)
    return new Error(`PLUGIN_GITHUB_RATE_LIMITED: ${name}`)
  return error
}

/** 目录 dir 下的子目录 path；跳出 dir 或不存在时抛错。 */
async function directoryInside(dir: string, path: string | undefined): Promise<string> {
  const target = path ? resolve(dir, path) : dir
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new Error(`PLUGIN_SOURCE_PATH_INVALID: ${path ?? ""}`)
  }
  const info = await stat(target).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`PLUGIN_SOURCE_PATH_MISSING: ${path ?? "."}`)
  return target
}

/** 解开后只有一个顶层目录时（npm pack 的 `package/`）进到它里面。 */
async function singleChild(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  const only = entries.length === 1 ? entries[0] : undefined
  return only?.isDirectory() ? join(dir, only.name) : dir
}

/** 下载到临时目录的来源：dir 是插件（或市场）所在目录，用完调用 cleanup。 */
export interface Materialized {
  dir: string
  cleanup: () => Promise<void>
}

/** 把远程来源下载并解到临时目录。 */
export async function materializeSource(source: RemoteSource, io: SourceIo): Promise<Materialized> {
  const root = await mkdtemp(join(tmpdir(), "pigcode-source-"))
  const cleanup = () => rm(root, { recursive: true, force: true })
  try {
    if (source.kind === "github") {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Pigcode-Plugin-Installer",
        ...(io.githubToken ? { Authorization: `Bearer ${io.githubToken}` } : {}),
      }
      const bytes = await downloadBytes(githubArchiveUrl(source), {
        fetcher: io.fetcher,
        headers,
        maxBytes: ARCHIVE_MAX_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      }).catch((error: unknown) => {
        throw githubError(error, source)
      })
      await extractTarGz(bytes, root, { strip: 1 })
      return { dir: await directoryInside(root, source.path), cleanup }
    }
    if (source.kind === "git") {
      const checkout = join(root, "checkout")
      await io.runGit([
        "clone",
        "--depth",
        "1",
        ...(source.ref ? ["--branch", source.ref] : []),
        "--",
        source.url,
        checkout,
      ])
      await rm(join(checkout, ".git"), { recursive: true, force: true })
      return { dir: await directoryInside(checkout, source.path), cleanup }
    }
    const bytes = await downloadBytes(source.url, {
      fetcher: io.fetcher,
      maxBytes: ARCHIVE_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    })
    if (source.sha256) {
      const actual = createHash("sha256").update(bytes).digest("hex")
      if (actual !== source.sha256.toLowerCase()) {
        throw new Error(`PLUGIN_ARCHIVE_SHA256_MISMATCH: expected ${source.sha256}, got ${actual}`)
      }
    }
    const extracted = join(root, "archive")
    await extractTarGz(bytes, extracted)
    return { dir: await singleChild(extracted), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** 市场条目里的 sha256 只认 64 位十六进制。 */
export function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value.toLowerCase())
}

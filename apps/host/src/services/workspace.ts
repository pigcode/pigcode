/** 提供线程工作区的文件树、文本读取与内容搜索；所有路径都限制在项目根目录内。 */
import type { Context } from "cordis"
import { execFile } from "node:child_process"
import { open, readdir, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { resolveInside, resolveRealInside } from "./path-safety"

const exec = promisify(execFile)

/** 子进程输出上限，避免一次性拉取超大仓库。 */
const MAX_BUFFER = 8 * 1024 * 1024
/** 单次读取的最大字节数，超出部分标记为截断。 */
const MAX_FILE_BYTES = 1024 * 1024
/** 搜索返回的最大命中数，防止 UI 被大仓库拖垮。 */
const MAX_SEARCH_RESULTS = 200
/** 二进制探测只检查文件开头的这些字节。 */
const BINARY_SNIFF_BYTES = 8 * 1024
/** 非 git 项目回退递归时忽略的目录。 */
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "out"])

/** 文件树条目；目录由渲染端从路径推导。 */
export interface WorkspaceEntry {
  path: string
  type: "file"
}

/** 文本文件读取结果；二进制文件不返回文本内容。 */
export interface ReadFileResult {
  path: string
  text: string
  truncated: boolean
  binary: boolean
}

/** 一条搜索命中；行号从 1 开始。 */
export interface SearchMatch {
  path: string
  line: number
  text: string
}

/** 工作区读写入口。 */
export interface WorkspaceService {
  tree(threadId: string): Promise<WorkspaceEntry[]>
  readFile(threadId: string, path: string): Promise<ReadFileResult>
  search(threadId: string, query: string, glob?: string): Promise<SearchMatch[]>
}

declare module "cordis" {
  interface Context {
    workspace: WorkspaceService
  }
}

/** workspace 插件依赖的服务。 */
export const inject = ["projects", "threads", "storage"]

/** workspace 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface WorkspacePlugin {
  (ctx: Context): void
  inject: string[]
}

/** 注册 workspace 服务。 */
export const apply: WorkspacePlugin = (ctx) => {
  const service: WorkspaceService = {
    async tree(threadId) {
      const root = projectRoot(ctx, threadId)
      const files = await listFiles(root)
      return files.map((path) => ({ path, type: "file" as const }))
    },
    async readFile(threadId, requestPath) {
      const root = projectRoot(ctx, threadId)
      return readTextFile(root, requestPath)
    },
    async search(threadId, query, glob) {
      const root = projectRoot(ctx, threadId)
      return searchFiles(root, query, glob)
    },
  }
  ctx.provide("workspace", service)
}

apply.inject = inject

/** 解析线程对应的项目根目录；M3 先使用项目根，Task 5 会优先使用活动 worktree。 */
function projectRoot(ctx: Context, threadId: string): string {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const project = ctx.projects.list().find((item) => item.id === thread.projectId)
  if (!project) throw new Error(`project not found: ${thread.projectId}`)
  return project.rootPath
}

/** 优先用 git 列出跟踪与未跟踪文件；非 git 项目回退到递归读取目录。 */
async function listFiles(root: string): Promise<string[]> {
  const tracked = await gitLsFiles(root)
  if (tracked) return tracked.sort()
  return (await walkFiles(root, "")).sort()
}

/** 运行 git ls-files；git 不可用或目录不是仓库时返回 null。 */
async function gitLsFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: MAX_BUFFER },
    )
    return stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map(toPosix)
  } catch {
    return null
  }
}

/** 递归读取目录，跳过依赖、构建产物和 .git。 */
async function walkFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      files.push(...(await walkFiles(root, join(prefix, entry.name))))
    } else if (entry.isFile()) {
      files.push(toPosix(join(prefix, entry.name)))
    }
  }
  return files
}

/** 读取根目录内的文本文件；超过 1MB 截断，含 NUL 的按二进制处理。 */
async function readTextFile(root: string, requestPath: string): Promise<ReadFileResult> {
  const lexical = resolveInside(root, requestPath)
  const target = await resolveRealInside(root, requestPath)
  const info = await stat(target)
  if (!info.isFile()) throw new Error(`not a file: ${requestPath}`)

  const length = Math.min(info.size, MAX_FILE_BYTES)
  const handle = await open(target, "r")
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    return {
      path: toPosix(relative(resolve(root), lexical)),
      text: binary ? "" : bytes.toString("utf8"),
      truncated: info.size > MAX_FILE_BYTES,
      binary,
    }
  } finally {
    await handle.close()
  }
}

/** 优先 ripgrep，缺失时回退 git grep；两者都不可用时返回空结果。 */
async function searchFiles(root: string, query: string, glob?: string): Promise<SearchMatch[]> {
  try {
    const args = ["--line-number", "--no-heading", "--color", "never"]
    if (glob) args.push("-g", glob)
    args.push("--", query, ".")
    return parseSearchOutput(await runTool("rg", args, root))
  } catch (error) {
    if (!isMissingCommand(error)) throw error
  }

  try {
    const args = ["grep", "-n", "--no-color", "-e", query]
    if (glob) args.push("--", glob)
    return parseSearchOutput(await runTool("git", args, root))
  } catch {
    return []
  }
}

/** 执行搜索工具；exit code 1 表示没有命中，不算失败。 */
async function runTool(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(command, args, { cwd, maxBuffer: MAX_BUFFER })
    return stdout
  } catch (error) {
    const code = errorField(error, "code")
    if (code === 1 || code === "1") {
      const stdout = errorField(error, "stdout")
      return typeof stdout === "string" ? stdout : ""
    }
    throw error
  }
}

/** 解析 rg/git grep 的 `path:line:text` 输出，并限制结果条数。 */
export function parseSearchOutput(raw: string, limit = MAX_SEARCH_RESULTS): SearchMatch[] {
  const matches: SearchMatch[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (matches.length >= limit) break
    if (line.length === 0) continue
    const first = line.indexOf(":")
    const second = line.indexOf(":", first + 1)
    if (first <= 0 || second <= first) continue
    const lineNumber = Number(line.slice(first + 1, second))
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) continue
    matches.push({
      path: line.slice(0, first),
      line: lineNumber,
      text: line.slice(second + 1),
    })
  }
  return matches
}

/** 读取错误对象上的字段，避免使用 any。 */
function errorField(error: unknown, key: "code" | "stdout"): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined
  return (error as Record<string, unknown>)[key]
}

/** 命令不存在时允许回退到另一个搜索工具。 */
function isMissingCommand(error: unknown): boolean {
  return errorField(error, "code") === "ENOENT"
}

/** 把平台路径分隔符统一为 `/`，供 RPC 和 UI 使用。 */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

/**
 * 线程工作区的文件服务：整棵文件列表（输入框的 @ 引用）、按目录懒加载的文件树、路径搜索、
 * 内容搜索、读取与保存。路径都相对线程的工作目录（活动 worktree 优先），并限制在其中。
 */
import type { Context } from "cordis"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createPathIndex, searchPaths, type PathSearchResult } from "./path-search"
import {
  listDirectory,
  readWorkspaceFile,
  writeWorkspaceFile,
  type DirectoryListing,
  type ReadFileResult,
  type WorkspaceEntry,
  type WriteFileResult,
} from "./workspace-files"
import { scopeCwd, type WorkspaceScope } from "./worktrees"

export type {
  DirectoryEntry,
  DirectoryListing,
  ReadFileResult,
  WorkspaceEntry,
  WriteFileResult,
} from "./workspace-files"
export { FileChangedError } from "./workspace-files"

const exec = promisify(execFile)

/** 子进程输出上限，避免一次性拉取超大仓库。 */
const MAX_BUFFER = 8 * 1024 * 1024
/** 内容搜索返回的最大命中数，防止界面被大仓库拖垮。 */
const MAX_SEARCH_RESULTS = 200

/** 一条内容搜索命中；行号从 1 开始。 */
export interface SearchMatch {
  path: string
  line: number
  text: string
}

/** 保存文件的选项。 */
export interface WriteOptions {
  /** 读取时的修改时间；文件在这之后被改过就拒绝覆盖。 */
  expectedMtimeMs?: number | undefined
  eol?: "lf" | "crlf" | undefined
}

/** 工作区读写入口；scope 是会话 id，或者新会话草稿的项目（看项目根目录）。 */
export interface WorkspaceService {
  /** 工作目录的绝对路径。 */
  root(scope: WorkspaceScope): string
  tree(scope: WorkspaceScope): Promise<WorkspaceEntry[]>
  /** 项目根目录里的文件；还没有会话（新会话草稿）时用。 */
  projectTree(projectId: string): Promise<WorkspaceEntry[]>
  /** 列出一个目录；空字符串表示工作目录本身。 */
  list(scope: WorkspaceScope, path?: string): Promise<DirectoryListing>
  /** 按路径模糊搜索文件与目录。 */
  searchPaths(
    scope: WorkspaceScope,
    query: string,
    limit?: number,
    refresh?: boolean,
  ): Promise<PathSearchResult>
  readFile(
    scope: WorkspaceScope,
    path: string,
    encoding?: "text" | "image",
  ): Promise<ReadFileResult>
  writeFile(
    scope: WorkspaceScope,
    path: string,
    text: string,
    options?: WriteOptions,
  ): Promise<WriteFileResult>
  search(scope: WorkspaceScope, query: string, glob?: string): Promise<SearchMatch[]>
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
  const index = createPathIndex()
  const service: WorkspaceService = {
    root: (scope) => scopeCwd(ctx, scope),
    async tree(scope) {
      const files = await index.files(scopeCwd(ctx, scope))
      return files.map((path) => ({ path, type: "file" as const }))
    },
    async projectTree(projectId) {
      const project = ctx.projects.get(projectId)
      if (!project) throw new Error(`project not found: ${projectId}`)
      const files = await index.files(project.rootPath)
      return files.map((path) => ({ path, type: "file" as const }))
    },
    list: (scope, path = "") => listDirectory(scopeCwd(ctx, scope), path),
    async searchPaths(scope, query, limit, refresh) {
      const root = scopeCwd(ctx, scope)
      if (refresh) index.invalidate(root)
      return searchPaths(await index.files(root), query, limit)
    },
    readFile: (scope, path, encoding) => readWorkspaceFile(scopeCwd(ctx, scope), path, encoding),
    async writeFile(scope, path, text, options = {}) {
      const root = scopeCwd(ctx, scope)
      const result = await writeWorkspaceFile(root, path, text, options)
      index.invalidate(root)
      return result
    },
    search: (scope, query, glob) => searchFiles(scopeCwd(ctx, scope), query, glob),
  }
  ctx.provide("workspace", service)
}

apply.inject = inject

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

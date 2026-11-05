/**
 * 工作区的文件操作：列出整棵树或一个目录（标记被 git 忽略的条目）、读取文本或图片、保存编辑。
 * 所有路径都是相对线程工作目录的 posix 路径，解析时做词法与符号链接两道越界检查。
 */
import { execFile } from "node:child_process"
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { resolveInside, resolveRealInside } from "./path-safety"

const exec = promisify(execFile)

/** 子进程输出上限，避免一次性拉取超大仓库。 */
const MAX_BUFFER = 32 * 1024 * 1024
/** 单次读取文本的最大字节数，超出部分标记为截断。 */
export const MAX_TEXT_BYTES = 1024 * 1024
/** 图片预览的最大字节数；更大的图片只给出提示。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 编辑后保存的最大字节数。 */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024
/** 一个目录最多列出的条目数；更多时标记截断。 */
export const MAX_DIRECTORY_ENTRIES = 2000
/** 二进制探测只检查文件开头的这些字节。 */
const BINARY_SNIFF_BYTES = 8 * 1024
/** 非 git 项目回退递归时跳过、目录列表里标成忽略的目录。 */
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "out"])
/** 能在界面里预览的图片格式。 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
}

/** 文件树条目；目录由渲染端从路径推导。 */
export interface WorkspaceEntry {
  path: string
  type: "file"
}

/** 目录列表里的一项。 */
export interface DirectoryEntry {
  path: string
  name: string
  kind: "file" | "directory"
  /** 被 .gitignore 忽略（或非 git 项目里的依赖与构建目录），界面淡化显示。 */
  ignored?: true
  /** 符号链接；kind 是链接目标的类型。 */
  symlink?: true
  size?: number
}

/** 一个目录的列表结果。 */
export interface DirectoryListing {
  path: string
  entries: DirectoryEntry[]
  truncated: boolean
}

/** 文件读取结果：文本或图片；二进制与过大的文件不返回内容。 */
export interface ReadFileResult {
  path: string
  text: string
  truncated: boolean
  binary: boolean
  size: number
  mtimeMs: number
  /** 文本原来的换行符；保存时按它写回。 */
  eol: "lf" | "crlf"
  /** 图片的 MIME 类型与 base64 内容；只有按图片读取时才有。 */
  image?: { mime: string; base64: string } | undefined
}

/** 保存结果；mtimeMs 作为下一次保存的冲突基准。 */
export interface WriteFileResult {
  path: string
  size: number
  mtimeMs: number
}

/** 文件在读取后被别处改过；界面据此提示重新加载或覆盖。 */
export class FileChangedError extends Error {
  readonly code = "FILE_CHANGED"
  constructor(
    path: string,
    readonly mtimeMs: number,
  ) {
    super(`FILE_CHANGED: ${path} was modified on disk`)
    this.name = "FileChangedError"
  }
}

/** 把平台路径分隔符统一为 `/`，供 RPC 和界面使用。 */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

/** 优先用 git 列出跟踪与未跟踪文件；非 git 项目回退到递归读取目录。 */
export async function listFiles(root: string): Promise<string[]> {
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

/**
 * 问 git 哪些路径被忽略；目录带尾斜杠，这样 `build/` 这类规则也能命中。
 * 不是 git 仓库时返回 null，由调用方退回到固定的忽略目录名。
 */
export async function gitIgnored(
  root: string,
  paths: readonly string[],
): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set()
  return new Promise((resolvePromise) => {
    const child = execFile(
      "git",
      ["check-ignore", "-z", "--stdin"],
      { cwd: root, maxBuffer: MAX_BUFFER },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code
        // exit 1 表示没有任何路径被忽略；其他错误（不是仓库、没有 git）不提供忽略信息。
        if (error && code !== 1) {
          resolvePromise(null)
          return
        }
        resolvePromise(new Set(String(stdout).split("\0").filter(Boolean)))
      },
    )
    // git 可能没读输入就退出了（不是仓库、目录已经不在）。这时管道没人读，写入以 EPIPE 结束；
    // 没有监听的话这个错误事件会让整个 Host 退出。结果由上面的回调给出，忽略即可。
    child.stdin?.on("error", () => undefined)
    child.stdin?.end(`${paths.join("\0")}\0`)
  })
}

/** 按「目录在前、名称自然排序」比较两个条目。 */
function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * 列出一个目录（空字符串表示根目录）：跟随符号链接得到条目类型，跳过 .git，
 * 用 git check-ignore 标记被忽略的条目。条目过多时只返回前 2000 个。
 */
export async function listDirectory(root: string, directory: string): Promise<DirectoryListing> {
  const target = directory ? await resolveRealInside(root, directory) : resolve(root)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error(`not a directory: ${directory}`)
  const dirents = (await readdir(target, { withFileTypes: true })).filter(
    (dirent) => dirent.name !== ".git",
  )
  const entries: DirectoryEntry[] = []
  for (const dirent of dirents) {
    const path = directory ? `${directory}/${dirent.name}` : dirent.name
    let kind: DirectoryEntry["kind"] = dirent.isDirectory() ? "directory" : "file"
    let size: number | undefined
    if (dirent.isSymbolicLink() || dirent.isFile()) {
      // 坏掉的链接按文件列出，打开时再报错。
      const linked = await stat(join(target, dirent.name)).catch(() => null)
      if (linked?.isDirectory()) kind = "directory"
      else size = linked?.size
    }
    entries.push({
      path,
      name: dirent.name,
      kind,
      ...(dirent.isSymbolicLink() ? { symlink: true as const } : {}),
      ...(size === undefined ? {} : { size }),
    })
  }
  entries.sort(compareEntries)
  const truncated = entries.length > MAX_DIRECTORY_ENTRIES
  const shown = truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries
  const ignored = await gitIgnored(
    root,
    shown.map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path)),
  )
  for (const entry of shown) {
    const hit = ignored
      ? ignored.has(entry.path) || ignored.has(`${entry.path}/`)
      : entry.kind === "directory" && IGNORED_DIRECTORIES.has(entry.name)
    if (hit) entry.ignored = true
  }
  return { path: directory, entries: shown, truncated }
}

/** 文件里出现 CRLF 就按 CRLF 写回。 */
function detectEol(text: string): "lf" | "crlf" {
  return text.includes("\r\n") ? "crlf" : "lf"
}

/**
 * 读取根目录内的文件：图片按 base64 返回（不超过 8MB），文本超过 1MB 截断，
 * 开头含 NUL 的按二进制处理不返回内容。
 */
export async function readWorkspaceFile(
  root: string,
  requestPath: string,
  encoding: "text" | "image" = "text",
): Promise<ReadFileResult> {
  const lexical = resolveInside(root, requestPath)
  const target = await resolveRealInside(root, requestPath)
  const info = await stat(target)
  if (!info.isFile()) throw new Error(`not a file: ${requestPath}`)
  const path = toPosix(relative(resolve(root), lexical))
  const base = { path, size: info.size, mtimeMs: info.mtimeMs }
  const mime = IMAGE_TYPES[extname(target).toLowerCase()]
  if (encoding === "image" && mime) {
    if (info.size > MAX_IMAGE_BYTES) {
      return { ...base, text: "", truncated: true, binary: true, eol: "lf" }
    }
    const data = await readFile(target)
    return {
      ...base,
      text: "",
      truncated: false,
      binary: true,
      eol: "lf",
      image: { mime, base64: data.toString("base64") },
    }
  }
  const length = Math.min(info.size, MAX_TEXT_BYTES)
  const handle = await open(target, "r")
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    const text = binary ? "" : bytes.toString("utf8")
    return { ...base, text, truncated: info.size > MAX_TEXT_BYTES, binary, eol: detectEol(text) }
  } finally {
    await handle.close()
  }
}

/** 路径里有 .git 目录时拒绝写入，不让编辑器改仓库元数据。 */
function assertNotGitMetadata(requestPath: string): void {
  if (requestPath.split(/[\\/]/).includes(".git")) {
    throw new Error(`refusing to write git metadata: ${requestPath}`)
  }
}

/**
 * 保存编辑：只覆盖已有的普通文件，内容按原来的换行符写回。
 * 给了 expectedMtimeMs 时先比对修改时间，文件在读取后被改过就抛出 FileChangedError。
 */
export async function writeWorkspaceFile(
  root: string,
  requestPath: string,
  text: string,
  options: { expectedMtimeMs?: number | undefined; eol?: "lf" | "crlf" | undefined } = {},
): Promise<WriteFileResult> {
  assertNotGitMetadata(requestPath)
  const lexical = resolveInside(root, requestPath)
  const target = await resolveRealInside(root, requestPath)
  const before = await stat(target)
  if (!before.isFile()) throw new Error(`not a file: ${requestPath}`)
  if (
    options.expectedMtimeMs !== undefined &&
    Math.abs(before.mtimeMs - options.expectedMtimeMs) > 1
  ) {
    throw new FileChangedError(requestPath, before.mtimeMs)
  }
  const content = options.eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`file too large to save: ${requestPath}`)
  }
  // 原地写入：保留文件权限与硬链接，不像临时文件改名那样换掉 inode。
  await writeFile(target, content, "utf8")
  const after = await stat(target)
  return {
    path: toPosix(relative(resolve(root), lexical)),
    size: after.size,
    mtimeMs: after.mtimeMs,
  }
}

/** 工作区的文件与目录写操作：保存、新建、重命名与安全删除。 */
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { resolveInside, resolveRealInside } from "./path-safety"

/** 编辑后保存的最大字节数。 */
export const MAX_WRITE_BYTES = 5 * 1024 * 1024

/** 保存结果；mtimeMs 作为下一次保存的冲突基准。 */
export interface WriteFileResult {
  path: string
  size: number
  mtimeMs: number
}

/** 重命名或移动结果。 */
export interface RenamePathResult {
  oldPath: string
  newPath: string
}

/** 删除文件或目录的结果。 */
export interface DeletePathResult {
  path: string
  deleted: true
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

/** 目标文件或目录已存在，拒绝覆盖。 */
export class PathExistsError extends Error {
  readonly code = "PATH_EXISTS"
  constructor(path: string) {
    super(`PATH_EXISTS: ${path} already exists`)
    this.name = "PathExistsError"
  }
}

/** 目标目录非空，需显式传入 recursive 才允许删除。 */
export class DirectoryNotEmptyError extends Error {
  readonly code = "DIR_NOT_EMPTY"
  constructor(path: string) {
    super(`DIR_NOT_EMPTY: ${path} is not empty`)
    this.name = "DirectoryNotEmptyError"
  }
}

/** 路径受保护（如 .git 或工作区根目录）或逃逸出工作区，拒绝写入。 */
export class PathForbiddenError extends Error {
  readonly code = "PATH_FORBIDDEN"
  constructor(path: string, detail?: string) {
    super(detail ? `PATH_FORBIDDEN: ${detail}` : `PATH_FORBIDDEN: ${path}`)
    this.name = "PathForbiddenError"
  }
}

/** 把平台路径分隔符统一为 `/`，供 RPC 和界面使用。 */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

function errorCodeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return (error as { code?: unknown }).code
}

function isRealInside(realRoot: string, realTarget: string): boolean {
  if (realTarget === realRoot) return true
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  return realTarget.startsWith(prefix)
}

/** 路径里有 .git 目录或文件时拒绝写入（大小写无关，兼容 macOS/Windows 大小写不敏感文件系统）。 */
function assertNotGitMetadata(requestPath: string): void {
  if (requestPath.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")) {
    throw new PathForbiddenError(requestPath, `refusing to write git metadata: ${requestPath}`)
  }
}

/** 词法校验写操作目标：禁止空路径、工作区根目录本身、越界路径与 .git 元数据。 */
function resolveWritableChild(
  root: string,
  requestPath: string,
): { normalizedRoot: string; lexical: string } {
  assertNotGitMetadata(requestPath)
  const normalizedRoot = resolve(root)
  const lexical = resolveInside(normalizedRoot, requestPath)
  if (lexical === normalizedRoot) {
    throw new PathForbiddenError(requestPath, `cannot modify workspace root: ${requestPath}`)
  }
  const rel = toPosix(relative(normalizedRoot, lexical))
  assertNotGitMetadata(rel)
  return { normalizedRoot, lexical }
}

/** 校验目标的最近已存在祖先目录在 realpath 解析后仍位于工作区根目录内且不在 .git 内。 */
async function assertNearestAncestorRealInside(
  root: string,
  lexical: string,
  requestPath: string,
): Promise<string> {
  const normalizedRoot = resolve(root)
  const realRoot = await realpath(normalizedRoot)
  let current = dirname(lexical)
  while (true) {
    try {
      await lstat(current)
      let realCurrent: string
      try {
        realCurrent = await realpath(current)
      } catch {
        throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
      }
      if (!isRealInside(realRoot, realCurrent)) {
        throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
      }
      const rel = toPosix(relative(realRoot, realCurrent))
      if (rel) assertNotGitMetadata(rel)
      return realRoot
    } catch (error) {
      if (error instanceof PathForbiddenError) throw error
      if (errorCodeOf(error) !== "ENOENT") throw error
      if (current === normalizedRoot) throw error
      const parent = dirname(current)
      if (parent === current) {
        throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
      }
      current = parent
    }
  }
}

/** 校验目标的直接父目录存在且 realpath 位于工作区根目录内且不在 .git 内。 */
async function assertParentRealInside(
  root: string,
  lexical: string,
  requestPath: string,
): Promise<string> {
  const normalizedRoot = resolve(root)
  const realRoot = await realpath(normalizedRoot)
  const parent = dirname(lexical)
  await lstat(parent)
  let realParent: string
  try {
    realParent = await realpath(parent)
  } catch {
    throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
  }
  if (!isRealInside(realRoot, realParent)) {
    throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
  }
  const rel = toPosix(relative(realRoot, realParent))
  if (rel) assertNotGitMetadata(rel)
  return realRoot
}

/** 判断目标路径（不跟随末尾符号链接）是否已存在。 */
async function lstatExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return false
    throw error
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
  const { normalizedRoot, lexical } = resolveWritableChild(root, requestPath)
  const target = await resolveRealInside(root, requestPath)
  const realRoot = await realpath(normalizedRoot)
  const realRel = toPosix(relative(realRoot, target))
  if (realRel) assertNotGitMetadata(realRel)
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
    path: toPosix(relative(normalizedRoot, lexical)),
    size: after.size,
    mtimeMs: after.mtimeMs,
  }
}

/**
 * 新建文件：自动创建缺失父目录，使用排他标志避免竞态覆盖已有文件或符号链接。
 */
export async function createWorkspaceFile(
  root: string,
  requestPath: string,
  text = "",
): Promise<WriteFileResult> {
  const { normalizedRoot, lexical } = resolveWritableChild(root, requestPath)
  await assertNearestAncestorRealInside(normalizedRoot, lexical, requestPath)
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
    throw new Error(`file too large to save: ${requestPath}`)
  }
  if (await lstatExists(lexical)) {
    throw new PathExistsError(requestPath)
  }
  await mkdir(dirname(lexical), { recursive: true })
  await assertParentRealInside(normalizedRoot, lexical, requestPath)
  try {
    await writeFile(lexical, text, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (errorCodeOf(error) === "EEXIST") throw new PathExistsError(requestPath)
    throw error
  }
  const info = await stat(lexical)
  return {
    path: toPosix(relative(normalizedRoot, lexical)),
    size: info.size,
    mtimeMs: info.mtimeMs,
  }
}

/**
 * 重命名或移动工作区内的文件/目录：双侧拒绝 .git、根目录与越界路径，不覆盖已存在目标。
 */
export async function renameWorkspacePath(
  root: string,
  oldPath: string,
  newPath: string,
): Promise<RenamePathResult> {
  const src = resolveWritableChild(root, oldPath)
  const dst = resolveWritableChild(root, newPath)
  const realRoot = await assertParentRealInside(src.normalizedRoot, src.lexical, oldPath)
  const srcStat = await lstat(src.lexical)
  if (!srcStat.isSymbolicLink()) {
    const realSrc = await realpath(src.lexical)
    if (!isRealInside(realRoot, realSrc)) {
      throw new PathForbiddenError(oldPath, `path escapes project: ${oldPath}`)
    }
    const relSrc = toPosix(relative(realRoot, realSrc))
    if (relSrc) assertNotGitMetadata(relSrc)
  }
  if (src.lexical === dst.lexical) {
    throw new PathExistsError(newPath)
  }
  if (srcStat.isDirectory() && dst.lexical.startsWith(`${src.lexical}${sep}`)) {
    throw new PathForbiddenError(newPath, `cannot move directory into itself: ${newPath}`)
  }
  await assertNearestAncestorRealInside(dst.normalizedRoot, dst.lexical, newPath)
  if (await lstatExists(dst.lexical)) {
    throw new PathExistsError(newPath)
  }
  await mkdir(dirname(dst.lexical), { recursive: true })
  await assertParentRealInside(dst.normalizedRoot, dst.lexical, newPath)
  await rename(src.lexical, dst.lexical)
  return {
    oldPath: toPosix(relative(src.normalizedRoot, src.lexical)),
    newPath: toPosix(relative(dst.normalizedRoot, dst.lexical)),
  }
}

/**
 * 删除工作区内的文件、符号链接或目录：符号链接只删除链接本身不跟出工作区；
 * 非空目录未显式传 recursive: true 时抛出 DirectoryNotEmptyError。
 */
export async function deleteWorkspacePath(
  root: string,
  requestPath: string,
  options: { recursive?: boolean | undefined } = {},
): Promise<DeletePathResult> {
  const recursive = options.recursive === true
  const { normalizedRoot, lexical } = resolveWritableChild(root, requestPath)
  const realRoot = await assertParentRealInside(normalizedRoot, lexical, requestPath)
  const targetStat = await lstat(lexical)
  if (targetStat.isSymbolicLink()) {
    await rm(lexical, { recursive: false, force: false })
  } else {
    const realTarget = await realpath(lexical)
    if (!isRealInside(realRoot, realTarget)) {
      throw new PathForbiddenError(requestPath, `path escapes project: ${requestPath}`)
    }
    const realRel = toPosix(relative(realRoot, realTarget))
    if (realRel) assertNotGitMetadata(realRel)
    if (targetStat.isDirectory()) {
      if (!recursive) {
        const children = await readdir(lexical)
        if (children.length > 0) throw new DirectoryNotEmptyError(requestPath)
        try {
          await rmdir(lexical)
        } catch (error) {
          const code = errorCodeOf(error)
          if (code === "ENOTEMPTY" || code === "EEXIST") {
            throw new DirectoryNotEmptyError(requestPath)
          }
          throw error
        }
      } else {
        await rm(lexical, { recursive: true, force: false })
      }
    } else {
      await rm(lexical, { recursive: false, force: false })
    }
  }
  return {
    path: toPosix(relative(normalizedRoot, lexical)),
    deleted: true,
  }
}

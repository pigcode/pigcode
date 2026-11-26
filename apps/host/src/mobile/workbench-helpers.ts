/** 手机端工作台公共辅助：路径校验、语言提示推导、排序/截断工具与错误映射。 */
import { open } from "node:fs/promises"
import { basename, extname, isAbsolute } from "node:path"
import { MOBILE_WORKBENCH_PATH_MAX, type MobileWorkspaceDirectoryEntry } from "@pigcode/contracts"
import type { Context } from "cordis"
import { MobileRequestError } from "./request-error"

const windowsDrivePattern = /^[a-zA-Z]:/

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".dart": "dart",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "json",
  ".arb": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".go": "go",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sql": "sql",
  ".xml": "xml",
  ".svg": "xml",
  ".plist": "xml",
  ".toml": "toml",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".ini": "ini",
  ".conf": "ini",
  ".txt": "plaintext",
}

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 根据扩展名或特殊文件名推导语法高亮提示。 */
export function detectLanguageHint(filePath: string): string | undefined {
  const name = basename(filePath).toLowerCase()
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile"
  if (name === "makefile") return "makefile"
  if (name === "cmakelists.txt") return "cmake"
  if (name === ".env" || name.startsWith(".env.")) return "dotenv"
  const ext = extname(name)
  return ext ? EXTENSION_LANGUAGES[ext] : undefined
}

/** 校验并规范化工作区相对路径；拒绝绝对路径、盘符、NUL 与 `..` 穿越段。 */
export function normalizeRelativePath(raw: string, options: { allowEmpty: boolean }): string {
  if (raw === "") {
    if (options.allowEmpty) return ""
    throw new MobileRequestError("INVALID_PARAMS")
  }
  if (
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    windowsDrivePattern.test(raw) ||
    isAbsolute(raw)
  ) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  const segments = raw.replaceAll("\\", "/").split("/")
  const clean: string[] = []
  for (const segment of segments) {
    if (segment === "..") throw new MobileRequestError("INVALID_PARAMS")
    if (segment === "" || segment === ".") continue
    clean.push(segment)
  }
  if (clean.length === 0) {
    if (options.allowEmpty) return ""
    throw new MobileRequestError("INVALID_PARAMS")
  }
  const normalized = clean.join("/")
  if (normalized.length > MOBILE_WORKBENCH_PATH_MAX) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  return normalized
}

/** 目录优先于文件，同类按名称不区分大小写升序排列。 */
export function compareDirectoryEntries(
  left: MobileWorkspaceDirectoryEntry,
  right: MobileWorkspaceDirectoryEntry,
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
  const leftLower = left.name.toLowerCase()
  const rightLower = right.name.toLowerCase()
  if (leftLower !== rightLower) return leftLower < rightLower ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** 裁剪单行搜索预览到 maxLength 以内，避免切裂 UTF-16 代理对。 */
export function clipPreview(raw: string, maxLength: number): string {
  const singleLine = raw.replace(/[\r\n]+/g, " ")
  if (singleLine.length <= maxLength) return singleLine
  const prefix = singleLine.slice(0, maxLength - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

/** 截断在 1 MiB 处的缓冲区末尾若残留不完整 UTF-8 多字节序列，将其去掉避免出现乱码替代符。 */
export function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length
  if (len === 0) return buf
  for (let back = 0; back < 4 && len - 1 - back >= 0; back += 1) {
    const byte = buf[len - 1 - back]!
    if ((byte & 0x80) === 0) return buf
    if ((byte & 0xc0) === 0xc0) {
      const expected =
        (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1
      const available = back + 1
      return available < expected ? buf.subarray(0, len - 1 - back) : buf
    }
  }
  return buf
}

export function errorCodeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return (error as { code?: unknown }).code
}

/** 把底层路径/文件系统错误映射为规范的 MobileRequestError，绝不透传宿主机绝对路径。 */
export function mapWorkspaceError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  const code = errorCodeOf(error)
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOOP"
  ) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith("path escapes project:") ||
      message.startsWith("absolute path not allowed:") ||
      message === "path must not be empty" ||
      message.startsWith("not a directory:") ||
      message.startsWith("not a file:")
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
  }
  throw error
}

export async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0)
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function requireWorkspace(ctx: Context) {
  const workspace = ctx.get("workspace")
  if (!workspace) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  return workspace
}

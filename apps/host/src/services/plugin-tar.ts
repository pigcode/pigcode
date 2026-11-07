/**
 * 解 .tar.gz：GitHub 的仓库归档和 npm pack 出来的包都是这个格式。只写普通文件和目录，
 * 符号链接、硬链接和设备文件跳过；路径里有 `..`、是绝对路径或带盘符的归档直接拒绝，文件写不出目标目录。
 * 支持 pax（`x`）与 GNU（`L`）长路径头；文件数和解开后的总大小都有上限。
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"

const BLOCK = 512

export interface ExtractOptions {
  /** 去掉每个路径开头的几层目录，例如 GitHub 归档里的 `owner-repo-sha/`。 */
  strip?: number | undefined
  /** 解开后最多多少字节。 */
  maxBytes?: number | undefined
  /** 最多多少个文件。 */
  maxEntries?: number | undefined
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 20_000

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString("utf8")
}

function readSize(block: Buffer, offset: number, length: number): number {
  // 很大的文件用 base-256 编码：首字节最高位为 1。
  if ((block[offset] ?? 0) & 0x80) {
    let value = 0
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + (block[index] ?? 0)
    }
    return value
  }
  const text = readString(block, offset, length).trim()
  return text ? Number.parseInt(text, 8) : 0
}

/** 头部校验和：校验和字段按 8 个空格计算，其余字节相加。 */
function checksumOk(block: Buffer): boolean {
  const expected = readSize(block, 148, 8)
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0)
  }
  return sum === expected
}

/** pax 扩展头：一行一条 `长度 key=value\n`。 */
function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8")
    const equals = record.indexOf("=")
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/** 归档里的路径换成目标目录下的相对路径；去掉 strip 层后为空时返回 null。 */
function safeRelative(name: string, strip: number): string | null {
  const normalized = name.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`PLUGIN_ARCHIVE_UNSAFE: absolute path in archive: ${name}`)
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.some((part) => part === ".." || part.includes(":"))) {
    throw new Error(`PLUGIN_ARCHIVE_UNSAFE: path escapes the archive: ${name}`)
  }
  const kept = parts.slice(strip)
  return kept.length > 0 ? kept.join("/") : null
}

/** 解开 gzip 压缩的 tar 到 dest；返回写入的文件数。 */
export async function extractTarGz(
  data: Uint8Array,
  dest: string,
  options: ExtractOptions = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const strip = options.strip ?? 0
  let archive: Buffer
  try {
    archive = gunzipSync(data, { maxOutputLength: maxBytes + 64 * BLOCK })
  } catch (error) {
    throw new Error(
      `PLUGIN_ARCHIVE_INVALID: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let offset = 0
  let files = 0
  let total = 0
  let paxPath: string | undefined
  let longName: string | undefined
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (!checksumOk(header)) throw new Error("PLUGIN_ARCHIVE_INVALID: bad tar header checksum")
    const size = readSize(header, 124, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const start = offset + BLOCK
    const end = start + size
    if (end > archive.length) throw new Error("PLUGIN_ARCHIVE_INVALID: truncated tar entry")
    const body = archive.subarray(start, end)
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    if (type === "x") {
      paxPath = parsePax(body).path ?? paxPath
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      longName = readString(body, 0, body.length)
      continue
    }
    const ustar = readString(header, 257, 6).startsWith("ustar")
    const prefix = ustar ? readString(header, 345, 155) : ""
    const plain = readString(header, 0, 100)
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${plain}` : plain)
    paxPath = undefined
    longName = undefined
    const regular = type === "0" || type === "7"
    if (!regular && type !== "5") continue
    const relative = safeRelative(name, strip)
    if (relative === null) continue
    const target = join(dest, ...relative.split("/"))
    if (type === "5") {
      await mkdir(target, { recursive: true })
      continue
    }
    files += 1
    total += size
    if (files > maxEntries)
      throw new Error(`PLUGIN_ARCHIVE_TOO_LARGE: more than ${maxEntries} files`)
    if (total > maxBytes) throw new Error(`PLUGIN_ARCHIVE_TOO_LARGE: more than ${maxBytes} bytes`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return files
}

/**
 * 测试用的 .tar.gz 生成器：ustar 头，可以加 pax（`x`）或 GNU（`L`）长路径头，也能放符号链接，
 * 用来造 GitHub 归档和各种不安全的归档。只给测试用。
 */
import { gzipSync } from "node:zlib"

export interface TarFixtureEntry {
  name: string
  content?: string | Uint8Array
  type?: "file" | "dir" | "symlink"
  linkname?: string
  /** 用 pax 扩展头写路径（name 字段里只放截断的名字）。 */
  pax?: boolean
  /** 用 GNU 的 `././@LongLink` 写路径。 */
  gnuLongName?: boolean
}

function writeField(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value.slice(0, length), offset, length, "utf8")
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`
}

function header(name: string, size: number, type: string, linkname = ""): Buffer {
  const block = Buffer.alloc(512)
  writeField(block, 0, 100, name)
  writeField(block, 100, 8, octal(0o644, 8))
  writeField(block, 108, 8, octal(0, 8))
  writeField(block, 116, 8, octal(0, 8))
  writeField(block, 124, 12, octal(size, 12))
  writeField(block, 136, 12, octal(0, 12))
  block.fill(0x20, 148, 156)
  writeField(block, 156, 1, type)
  writeField(block, 157, 100, linkname)
  writeField(block, 257, 6, "ustar\0")
  writeField(block, 263, 2, "00")
  let sum = 0
  for (const byte of block) sum += byte
  writeField(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

function padded(body: Buffer): Buffer {
  const remainder = body.length % 512
  return remainder === 0 ? body : Buffer.concat([body, Buffer.alloc(512 - remainder)])
}

/** pax 记录：长度字段包含它自己的位数。 */
function paxRecord(key: string, value: string): string {
  const content = ` ${key}=${value}\n`
  let length = content.length + 1
  while (`${length}${content}`.length !== length) length += 1
  return `${length}${content}`
}

/** 生成 gzip 压缩的 tar。 */
export function tarGz(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body =
      entry.content === undefined
        ? Buffer.alloc(0)
        : typeof entry.content === "string"
          ? Buffer.from(entry.content, "utf8")
          : Buffer.from(entry.content)
    let name = entry.name
    if (entry.pax) {
      const record = Buffer.from(paxRecord("path", entry.name), "utf8")
      blocks.push(header("PaxHeader", record.length, "x"), padded(record))
      name = entry.name.slice(-90)
    } else if (entry.gnuLongName) {
      const long = Buffer.from(`${entry.name}\0`, "utf8")
      blocks.push(header("././@LongLink", long.length, "L"), padded(long))
      name = entry.name.slice(0, 99)
    }
    const type = entry.type === "dir" ? "5" : entry.type === "symlink" ? "2" : "0"
    const size = entry.type === "file" || entry.type === undefined ? body.length : 0
    blocks.push(header(name, size, type, entry.linkname))
    if (size > 0) blocks.push(padded(body))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** 只回一个固定响应体的 fetch 替身；记下请求过的地址与请求头。 */
export function fixedFetcher(body: Uint8Array | string, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    return new Response(typeof body === "string" ? body : Buffer.from(body), { status })
  }
  return { fetcher, calls }
}

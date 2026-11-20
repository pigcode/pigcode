import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "./process-tree"
import { x as untar } from "tar"
import { open as openZip, type Entry, type ZipFile } from "yauzl"
import type { AgentCliUpdateRuntime } from "./agent"

const maxDownload = 512 * 1024 * 1024
const maxUnpacked = 1024 * 1024 * 1024
const maxFiles = 25_000

export function relativeArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /[:\0]/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("Agent runtime contains an unsafe file path")
  }
  return normalized
}

function entryLimits() {
  let count = 0
  let bytes = 0
  return (size: number) => {
    count += 1
    bytes += size
    if (count > maxFiles || bytes > maxUnpacked)
      throw new Error("Agent runtime archive is too large")
  }
}

async function extractZip(archive: string, destination: string, signal: AbortSignal) {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZip(archive, { lazyEntries: true, validateEntrySizes: true }, (error, file) =>
      error ? reject(error) : resolve(file),
    )
  })
  const limit = entryLimits()
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once("error", reject)
      zip.once("end", resolve)
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          signal.throwIfAborted()
          const target = join(destination, relativeArchivePath(entry.fileName))
          const mode = (entry.externalFileAttributes >>> 16) & 0o777
          limit(entry.uncompressedSize)
          if (entry.fileName.endsWith("/")) {
            await mkdir(target, { recursive: true })
          } else if (((entry.externalFileAttributes >>> 16) & 0o170000) !== 0o120000) {
            await mkdir(dirname(target), { recursive: true })
            const source = await new Promise<Readable>((resolve, reject) =>
              zip.openReadStream(entry, (error, stream) =>
                error ? reject(error) : resolve(stream),
              ),
            )
            await pipeline(
              source,
              createWriteStream(target, { flags: "wx", mode: 0o600 | (mode & 0o100) }),
              { signal },
            )
          }
          zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

async function extractTar(
  archive: string,
  destination: string,
  bzip: boolean,
  signal: AbortSignal,
) {
  const limit = entryLimits()
  const extract = untar({
    cwd: destination,
    strict: true,
    preservePaths: false,
    noMtime: true,
    filter(path, entry) {
      if (path === "." || path === "./") return false
      relativeArchivePath(path)
      if (
        !("type" in entry) ||
        !["File", "Directory", "ContiguousFile", "OldFile"].includes(entry.type)
      )
        return false
      limit(entry.size)
      return true
    },
  })
  if (!bzip) {
    const file = await open(archive)
    await pipeline(file.createReadStream(), extract, { signal })
    return
  }
  const child = spawn("bzip2", ["-dc", archive], {
    ...PROCESS_TREE_SPAWN_OPTIONS,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const tree = ownProcessTree(child)
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Could not decompress the Agent runtime")),
    )
  })
  try {
    await Promise.all([pipeline(child.stdout, extract, { signal }), done])
  } finally {
    await tree.terminate()
  }
}

export async function downloadRuntime(
  fetcher: typeof fetch,
  asset: { url: string; digest?: string | undefined; command: string },
  destination: string,
  runtime: Pick<AgentCliUpdateRuntime, "signal" | "onProgress">,
) {
  const signal = AbortSignal.any([runtime.signal, AbortSignal.timeout(20 * 60_000)])
  const file = join(destination, ".download")
  const response = await fetcher(asset.url, { signal })
  if (!response.ok || !response.body || (!response.url.startsWith("https:") && response.url !== ""))
    throw new Error("Could not download the Agent runtime over HTTPS")
  const hash = createHash("sha256")
  const total = Number(response.headers.get("content-length"))
  let bytes = 0
  let reportedAt = 0
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    new Transform({
      transform(chunk: Buffer, _encoding, next) {
        bytes += chunk.length
        if (bytes > maxDownload) return next(new Error("Agent runtime download is too large"))
        hash.update(chunk)
        if (Date.now() - reportedAt > 250) {
          reportedAt = Date.now()
          runtime.onProgress?.({ stage: "downloading", bytes, ...(total > 0 ? { total } : {}) })
        }
        next(null, chunk)
      },
    }),
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
    { signal },
  )
  if (asset.digest && hash.digest("hex") !== asset.digest.toLowerCase())
    throw new Error("Agent runtime failed checksum validation")
  runtime.onProgress?.({ stage: "extracting" })
  const descriptor = await open(file)
  const header = Buffer.alloc(4)
  try {
    await descriptor.read(header)
  } finally {
    await descriptor.close()
  }
  const command = join(destination, relativeArchivePath(asset.command))
  if (header.subarray(0, 2).toString() === "PK") await extractZip(file, destination, signal)
  else if (header[0] === 0x1f && header[1] === 0x8b)
    await extractTar(file, destination, false, signal)
  else if (header.subarray(0, 3).toString() === "BZh")
    await extractTar(file, destination, true, signal)
  else {
    await mkdir(dirname(command), { recursive: true })
    await rename(file, command)
  }
  signal.throwIfAborted()
  await chmod(command, 0o700)
  await rm(file, { force: true })
  return command
}

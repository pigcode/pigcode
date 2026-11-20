import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { x as extract } from "tar"
import { parse } from "yaml"

const require = createRequire(import.meta.url)

interface PlatformPackage {
  name: string
  version: string
  os: string[]
  cpu: string[]
}

async function readPlatformPackage(directory: string): Promise<PlatformPackage> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
}

/** 从锁文件取目标 npm 包的完整性值，交叉打包时不会使用构建机架构的二进制。 */
async function fetchPlatformPackage(
  name: string,
  version: string,
  lockfile: string,
  temporary: string,
): Promise<string> {
  const lock = parse(await readFile(lockfile, "utf8")) as {
    packages?: Record<string, { resolution?: { integrity?: string } }>
  }
  const integrity = lock.packages?.[name + "@" + version]?.resolution?.integrity
  if (!integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))
    throw new Error("Missing Cursor platform package integrity in pnpm-lock.yaml: " + name)
  const url = `https://registry.npmjs.org/${name}/-/${basename(name)}-${version}.tgz`
  const signal = AbortSignal.timeout(120_000)
  const response = await fetch(url, { signal, redirect: "error" })
  if (!response.ok || !response.body)
    throw new Error("Could not download locked Cursor platform package: " + name)

  const archive = join(temporary, "cursor.tgz")
  let bytes = 0
  const hash = createHash("sha512")
  const verify = new Transform({
    transform(chunk, _encoding, next) {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) return next(new Error("Cursor platform archive is too large"))
      hash.update(chunk)
      next(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
    verify,
    createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    { signal },
  )
  if ("sha512-" + hash.digest("base64") !== integrity)
    throw new Error("Cursor platform package failed the pnpm lockfile integrity check: " + name)

  const directory = join(temporary, "package")
  await mkdir(directory)
  await extract({
    file: archive,
    cwd: directory,
    strip: 1,
    strict: true,
    preservePaths: false,
    filter: (path, entry) =>
      path.startsWith("package/") &&
      "type" in entry &&
      (entry.type === "File" || entry.type === "Directory"),
  })
  return directory
}

/** SDK 按入口脚本向上查找 node_modules，原生文件要放在 ASAR 外部。 */
export async function copyCursorRuntime(
  destination: string,
  platform: string,
  arch: string,
  lockfile?: string,
): Promise<void> {
  const entry = require.resolve("@cursor/sdk")
  const sdk = JSON.parse(
    await readFile(resolve(dirname(entry), "..", "..", "package.json"), "utf8"),
  ) as { optionalDependencies?: Record<string, string> }
  const name = `@cursor/sdk-${platform}-${arch}`
  const version = sdk.optionalDependencies?.[name]
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Cursor SDK has no platform package for " + platform + "-" + arch)

  let temporary: string | undefined
  try {
    const sdkRequire = createRequire(entry)
    let source: string
    try {
      source = dirname(sdkRequire.resolve(name + "/package.json"))
    } catch {
      if (!lockfile)
        throw new Error("Install the Cursor platform package for " + platform + "-" + arch)
      temporary = await mkdtemp(join(tmpdir(), "pigcode-cursor-runtime-"))
      source = await fetchPlatformPackage(name, version, lockfile, temporary)
    }

    const info = await readPlatformPackage(source)
    if (
      info.name !== name ||
      info.version !== version ||
      !info.os.includes(platform) ||
      !info.cpu.includes(arch)
    )
      throw new Error("Cursor platform package did not match the target: " + name)
    const executable = await lstat(join(source, "bin", platform === "win32" ? "rg.exe" : "rg"))
    if (!executable.isFile() || (platform !== "win32" && !(executable.mode & 0o111)))
      throw new Error("Cursor platform package is missing an executable rg: " + name)

    const target = join(destination, "node_modules", name)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, {
      recursive: true,
      filter: (path) => path !== join(source, "node_modules"),
    })
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}

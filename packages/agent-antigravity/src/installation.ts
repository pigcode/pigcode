/** Antigravity 发布包由 Google 分发，更新只切换已经验证的版本目录。 */
import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import {
  settingEnvironment,
  type AgentCliUpdatePlan,
  type AgentCliUpdateRuntime,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  cliUpdateAvailable,
  cliVersion,
  launchTarget,
  ownProcessTree,
  PROCESS_TREE_SPAWN_OPTIONS,
} from "@pigcode/plugin-sdk/node"
import { openAcp } from "./connection"
import { acpLaunch, configuredBinary, pathBinary } from "./launch"

const exec = promisify(execFile)
const manifestBase =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests"
const minimumVersion = "1.5.0"
const versionPattern = /^\d+\.\d+\.\d+$/
const releaseIdPattern = /^\d+\.\d+\.\d+-[a-f0-9]{16}$/
const maxBytes = 512 * 1024 * 1024

interface Release {
  version: string
  url: string
  digest: string
  name: string
  archive: boolean
}

interface Installed {
  version: string
  command: string
  releaseId: string
}

export interface Executable {
  command: string
  release(): void
}

function rootOf(instance: AgentInstanceContext) {
  return join(instance.sharedDir, "runtime")
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

async function readInstallation(root: string): Promise<Installed | null> {
  try {
    const id = (await readFile(join(root, "active"), "utf8")).trim()
    if (!releaseIdPattern.test(id)) return null
    const command = join(
      root,
      "versions",
      id,
      process.platform === "win32" ? "agy.exe" : "antigravity",
    )
    await access(command)
    return { command, version: id.slice(0, -17), releaseId: id }
  } catch {
    return null
  }
}

export async function executableVersion(
  command: string,
  settings: AgentSettingsValues,
): Promise<string | null> {
  try {
    const target = launchTarget(command, ["--version"])
    if (target.shell) return null
    const { stdout, stderr } = await exec(target.command, target.args, {
      env: agentEnvironment(settingEnvironment(settings)),
      timeout: 8_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return cliVersion(stdout) ?? cliVersion(stderr)
  } catch {
    return null
  }
}

async function latestRelease(fetchRelease: typeof fetch): Promise<Release> {
  const { platform, arch } = process
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error(
      "No managed Antigravity CLI for this platform. Set the executable path to a compatible CLI.",
    )
  const windows = platform === "win32"
  const family = windows ? "windows" : platform
  const musl =
    platform === "linux" &&
    (await access(
      arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1",
    ).then(
      () => true,
      () => false,
    ))
  const suffix = musl ? "_musl" : ""
  const target = `${family}_${arch === "x64" ? "amd64" : arch}${suffix}`
  const response = await fetchRelease(`${manifestBase}/${target}.json`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Could not read the Antigravity CLI release")
  const value = (await response.json()) as { version?: unknown; url?: unknown; sha512?: unknown }
  const { version, url, sha512 } = value
  if (
    typeof version !== "string" ||
    !versionPattern.test(version) ||
    typeof url !== "string" ||
    typeof sha512 !== "string" ||
    !/^[a-f0-9]{128}$/i.test(sha512) ||
    cliUpdateAvailable(version, minimumVersion)
  )
    throw new Error("The Antigravity CLI release is incompatible")
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-`
  const path = url.startsWith(prefix) ? url.slice(prefix.length) : ""
  const folder = `${family}-${arch === "arm64" ? "arm" : "x64"}${musl ? "-musl" : ""}`
  const os = platform === "darwin" ? "mac" : family
  const expected = `${folder}/cli_${os}_${arch}${suffix}.${windows ? "exe" : "tar.gz"}`
  if (!/^\d+\//.test(path) || path.slice(path.indexOf("/") + 1) !== expected)
    throw new Error("The Antigravity release returned an unexpected download location")
  return {
    version,
    url,
    digest: sha512.toLowerCase(),
    name: windows ? "agy.exe" : "antigravity",
    archive: !windows,
  }
}

function boundedBytes(track?: (chunk: Buffer) => void): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      if (size > maxBytes) return done(new Error("Antigravity CLI exceeds the size limit"))
      track?.(chunk)
      done(null, chunk)
    },
  })
}

async function unpack(archive: string, destination: string, asset: Release, signal: AbortSignal) {
  if (!asset.archive) {
    await copyFile(archive, destination)
    return
  }
  const options = { signal, maxBuffer: 32 * 1024, timeout: 60_000 }
  const [{ stdout: paths }, { stdout: entries }] = await Promise.all([
    exec("tar", ["-tzf", archive], options),
    exec("tar", ["-tvzf", archive], options),
  ])
  if (
    paths.trim() !== asset.name ||
    !entries.startsWith("-") ||
    entries.trim().split(/\r?\n/).length !== 1
  )
    throw new Error("Expected one Antigravity executable in the archive")
  const child = spawn("tar", ["-xOzf", archive, asset.name], {
    ...PROCESS_TREE_SPAWN_OPTIONS,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const tree = ownProcessTree(child)
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Could not extract Antigravity CLI")),
    )
  })
  try {
    await Promise.all([
      pipeline(
        child.stdout,
        boundedBytes(),
        createWriteStream(destination, { flags: "wx", mode: 0o700 }),
        { signal },
      ),
      exited,
    ])
  } finally {
    await tree.terminate()
  }
}

export class AntigravityInstallation {
  private readonly modifying = new Set<string>()
  private readonly removing = new Set<string>()
  private readonly leases = new Map<string, number>()
  private readonly releases = new Map<string, { until: number; promise: Promise<Release> }>()

  constructor(private readonly fetchRelease: typeof fetch = fetch) {}

  async resolve(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<string | undefined> {
    return (
      configuredBinary(settings) ??
      (await readInstallation(rootOf(instance)))?.command ??
      pathBinary(settings)
    )
  }

  async acquire(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<Executable> {
    const root = rootOf(instance)
    const command = await this.resolve(settings, instance)
    if (!command) throw new Error("Install Antigravity CLI in Agent settings")
    const resolved = await realpath(command).catch(() => command)
    if (!inside(root, resolved) && !inside(root, command)) return { command, release() {} }
    if (this.removing.has(root)) throw new Error("Antigravity CLI is being removed")
    this.leases.set(root, (this.leases.get(root) ?? 0) + 1)
    let released = false
    return {
      command,
      release: () => {
        if (released) return
        released = true
        const remaining = (this.leases.get(root) ?? 1) - 1
        if (remaining > 0) this.leases.set(root, remaining)
        else this.leases.delete(root)
      },
    }
  }

  async prepare(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<AgentCliUpdatePlan> {
    const root = rootOf(instance)
    const external = configuredBinary(settings)
    if (external) {
      const verify = () => executableVersion(external, settings)
      const version = await verify()
      return {
        target: external,
        currentVersion: version,
        latestVersion: null,
        command: null,
        available: false,
        reason: version ? "unknown-installation" : "not-installed",
        verify,
      }
    }
    const installed = await readInstallation(root)
    const local = installed ? undefined : pathBinary(settings)
    const currentVersion =
      installed?.version ?? (local ? await executableVersion(local, settings) : null)
    const cached = this.releases.get(root)
    const promise =
      cached && cached.until > Date.now() ? cached.promise : latestRelease(this.fetchRelease)
    this.releases.set(root, {
      until: cached?.promise === promise ? cached.until : Date.now() + 60_000,
      promise,
    })
    const release = await promise.catch(() => null)
    const verify = async () => (await readInstallation(root))?.version ?? null
    return {
      target: root,
      currentVersion,
      latestVersion: release?.version ?? null,
      available: Boolean(
        release && (!currentVersion || cliUpdateAvailable(currentVersion, release.version)),
      ),
      command: null,
      reason: null,
      verify,
      concurrent: true,
      canRemove: installed !== null,
      run:
        release || !currentVersion
          ? async (runtime) =>
              this.install(root, release ?? (await latestRelease(this.fetchRelease)), runtime)
          : undefined,
    }
  }

  async remove(
    instance: AgentInstanceContext,
    configured: readonly AgentSettingsValues[],
  ): Promise<void> {
    const root = rootOf(instance)
    if (this.modifying.has(root) || this.leases.has(root))
      throw new Error(
        "Antigravity CLI is in use. Stop the sessions or installation before removing it.",
      )
    this.modifying.add(root)
    this.removing.add(root)
    try {
      for (const settings of configured) {
        const binary = configuredBinary(settings)
        if (!binary) continue
        const resolved = await realpath(binary).catch(() => binary)
        if (inside(root, binary) || inside(root, resolved))
          throw new Error(
            "Clear executable paths pointing to the managed Antigravity CLI before removing it.",
          )
      }
      await rm(root, { recursive: true, force: true })
    } finally {
      this.removing.delete(root)
      this.modifying.delete(root)
    }
  }

  private async install(
    root: string,
    release: Release,
    runtime: AgentCliUpdateRuntime,
  ): Promise<void> {
    if (this.modifying.has(root))
      throw new Error("An Antigravity CLI operation is already in progress")
    this.modifying.add(root)
    const signal = AbortSignal.any([runtime.signal, AbortSignal.timeout(45 * 60_000)])
    let staging: string | undefined
    try {
      await mkdir(join(root, "versions"), { recursive: true, mode: 0o700 })
      staging = await mkdtemp(join(root, ".download-"))
      const archive = join(staging, "download")
      const executable = join(staging, release.name)
      runtime.onOutput(`Downloading Antigravity CLI ${release.version}\n`)
      runtime.onProgress?.({ stage: "downloading" })
      const response = await this.fetchRelease(release.url, { signal })
      if (!response.ok || !response.body) throw new Error("Could not download the Antigravity CLI")
      const hash = createHash("sha512")
      const stream = Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream<Uint8Array>,
      )
      const total = Number(response.headers.get("content-length"))
      let bytes = 0
      let lastReport = 0
      const trackDownload = (chunk: Buffer) => {
        hash.update(chunk)
        bytes += chunk.length
        const now = Date.now()
        if (now - lastReport < 250) return
        lastReport = now
        runtime.onProgress?.({ stage: "downloading", bytes, ...(total > 0 ? { total } : {}) })
      }
      await pipeline(
        stream,
        boundedBytes(trackDownload),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal },
      )
      if (hash.digest("hex") !== release.digest)
        throw new Error("Antigravity CLI failed checksum validation")
      runtime.onProgress?.({ stage: "extracting" })
      await unpack(archive, executable, release, signal)
      await chmod(executable, 0o700)
      runtime.onOutput("Verifying Antigravity ACP\n")
      runtime.onProgress?.({ stage: "verifying" })
      const workspace = await mkdtemp(join(tmpdir(), "pigcode-agy-verify-"))
      try {
        const profile = {
          directory: join(workspace, "profile"),
          tokenPath: join(workspace, "unused"),
        }
        const process = openAcp(await acpLaunch(executable, {}, profile, workspace))
        try {
          const info = await process.initialize(signal)
          if (cliVersion(info.agentInfo?.version ?? "") !== release.version)
            throw new Error("Antigravity CLI reported an unexpected version")
        } finally {
          await process.close()
        }
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
      signal.throwIfAborted()
      const id = `${release.version}-${randomUUID().replaceAll("-", "").slice(0, 16)}`
      const directory = join(root, "versions", id)
      await mkdir(directory, { mode: 0o700 })
      const next = join(staging, "active")
      try {
        await rename(executable, join(directory, release.name))
        await writeFile(next, id, { mode: 0o600 })
        signal.throwIfAborted()
        await rename(next, join(root, "active"))
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    } finally {
      this.modifying.delete(root)
      if (staging) await rm(staging, { recursive: true, force: true })
    }
  }
}

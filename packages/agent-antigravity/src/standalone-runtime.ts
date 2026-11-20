import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RegistryCatalog } from "@pigcode/plugin-sdk/acp-registry"
import { cliUpdateAvailable } from "@pigcode/plugin-sdk/node"
import { downloadRuntime } from "@pigcode/plugin-sdk/runtime-archive"
import type {
  AgentCliUpdatePlan,
  AgentCliUpdateRuntime,
  AgentInstanceContext,
} from "@pigcode/plugin-sdk"
import { openAcp } from "./connection"
import { acpLaunch } from "./launch"

const registryId = "antigravity-acp"
const platform = process.platform
const executable = platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"
const harness = platform === "win32" ? "localharness_external.exe" : "localharness_external"
const receipt = "standalone-runtime.json"

type ReleaseId = { version: string; digest: string }
type Asset = ReleaseId & { url: string }
type Ready = ReleaseId & { command: string }

function releaseId(value: unknown): ReleaseId {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !("digest" in value) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new Error("Invalid standalone Antigravity release record")
  return { version: value.version, digest: value.digest }
}

export const standaloneRoot = (scope: AgentInstanceContext) =>
  join(scope.sharedDir, "standalone-runtime")
const folder = (scope: AgentInstanceContext, record: ReleaseId) =>
  join(standaloneRoot(scope), record.digest)

async function runnable(path: string) {
  const file = await lstat(path)
  if (!file.isFile() || !file.size) return false
  await access(path, platform === "win32" ? constants.F_OK : constants.X_OK)
  return true
}

async function installed(scope: AgentInstanceContext, record: ReleaseId): Promise<Ready | null> {
  try {
    const directory = folder(scope, record)
    if (!(await lstat(directory)).isDirectory()) return null
    const pair = await Promise.all([
      runnable(join(directory, executable)),
      runnable(join(directory, harness)),
    ])
    if (!pair.every(Boolean)) return null
    return { ...record, command: join(directory, executable) }
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return null
    throw error
  }
}

async function verify(command: string, version: string, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-enterprise-verify-"))
  try {
    const draft = { directory: join(directory, "profile"), tokenPath: join(directory, "unused") }
    const launch = await acpLaunch(command, {}, draft, directory)
    const rpc = openAcp(launch)
    try {
      const result = await rpc.initialize(AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
      if (
        result.agentInfo?.name !== "antigravity-acp" ||
        result.agentInfo.version !== version ||
        !["oauth-business", "agent-platform"].every((id) =>
          result.authMethods?.some((method) => method.id === id),
        )
      )
        throw new Error(
          "Google's standalone runtime did not advertise the expected release and Enterprise sign-in",
        )
    } finally {
      await rpc.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function publishBundle(stage: string, scope: AgentInstanceContext, asset: Asset) {
  const target = folder(scope, asset)
  try {
    return await rename(stage, target)
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error
    if (await installed(scope, asset)) return
  }
  // 两个文件必须同时替换；临时保留旧目录，Windows 文件被占用时也能恢复原状。
  const old = join(standaloneRoot(scope), ".incomplete-" + randomUUID())
  await rename(target, old)
  try {
    await rename(stage, target)
  } catch (error) {
    await rename(old, target).catch(() => undefined)
    throw error
  }
  await rm(old, { recursive: true, force: true })
}

/** 实例记录是否选择独立发行版；已选择的实例共享同一个经过校验的 Google ZIP。 */
export class StandaloneRuntime {
  private readonly registry: RegistryCatalog
  private readonly installing = new Map<string, Promise<Ready>>()

  constructor(private readonly fetcher: typeof fetch) {
    this.registry = new RegistryCatalog(fetcher)
  }

  private async active(scope: AgentInstanceContext) {
    const text = await readFile(join(standaloneRoot(scope), "active.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      },
    )
    if (text === null) return null
    let record: ReleaseId
    try {
      record = releaseId(JSON.parse(text))
    } catch {
      return null
    }
    return installed(scope, record)
  }

  async selected(scope: AgentInstanceContext): Promise<Ready | null | undefined> {
    const opted = await access(join(scope.dataDir, receipt)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    return opted ? this.active(scope) : undefined
  }

  async updatePlan(
    scope: AgentInstanceContext,
    lease: (target: string) => () => void,
  ): Promise<AgentCliUpdatePlan | null> {
    const selected = await this.selected(scope)
    if (!selected) return null
    const latest = await this.latest().catch(() => null)
    const target = standaloneRoot(scope)
    return {
      target,
      currentVersion: selected.version,
      latestVersion: latest?.version ?? null,
      available: cliUpdateAvailable(selected.version, latest?.version ?? null),
      command: null,
      reason: null,
      concurrent: true,
      canRemove: true,
      verify: async () => (await this.selected(scope))?.version ?? null,
      run: latest
        ? async (runtime) => {
            const release = lease(target)
            try {
              await this.install(scope, latest, runtime)
            } finally {
              release()
            }
          }
        : undefined,
    }
  }

  async latest(): Promise<Asset> {
    const entry = await this.registry.get(registryId)
    const source = entry.source
    const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform
    const suffix = platform === "win32" ? "windows" : platform
    const arch = process.arch === "x64" ? "x86_64" : process.arch
    const version = entry.metadata.version
    const url = `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${version}-${suffix}-${arch}.zip`
    const args = platform === "linux" ? ["--uid="] : []
    if (
      !("archive" in source) ||
      source.archive !== url ||
      source.cmd !== "./" + executable ||
      !source.sha256 ||
      Object.keys(source.env ?? {}).length ||
      JSON.stringify(source.args ?? []) !== JSON.stringify(args)
    )
      throw new Error(
        "The ACP Registry did not supply Google's checksummed Antigravity binary distribution for this platform",
      )
    return { ...releaseId({ version, digest: source.sha256.toLowerCase() }), url }
  }

  async install(
    scope: AgentInstanceContext,
    asset: Asset,
    runtime: Pick<AgentCliUpdateRuntime, "signal" | "onProgress">,
  ): Promise<Ready> {
    const root = standaloneRoot(scope)
    // 每个实例独立选择账号，所有已选择的实例共同升级一份发行包。
    const preceding = this.installing.get(root)
    const pending = (preceding ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.activate(scope, asset, runtime))
    this.installing.set(root, pending)
    try {
      const ready = await pending
      runtime.signal.throwIfAborted()
      await mkdir(scope.dataDir, { recursive: true, mode: 0o700 })
      await writeFile(join(scope.dataDir, receipt), "", {
        flag: "a",
        mode: 0o600,
        signal: runtime.signal,
      })
      return ready
    } finally {
      if (this.installing.get(root) === pending) this.installing.delete(root)
    }
  }

  private async activate(
    scope: AgentInstanceContext,
    asset: Asset,
    runtime: Pick<AgentCliUpdateRuntime, "signal" | "onProgress">,
  ): Promise<Ready> {
    runtime.signal.throwIfAborted()
    const active = await this.active(scope)
    if (active && !cliUpdateAvailable(active.version, asset.version)) return active

    const root = standaloneRoot(scope)
    await mkdir(root, { recursive: true, mode: 0o700 })
    let ready = await installed(scope, asset)
    if (!ready) {
      const stage = await mkdtemp(join(root, ".download-"))
      try {
        const command = await downloadRuntime(
          this.fetcher,
          { url: asset.url, digest: asset.digest, command: executable },
          stage,
          runtime,
        )
        const sibling = join(stage, harness)
        if (!(await lstat(sibling)).isFile())
          throw new Error("The standalone Antigravity release has no matching harness")
        await chmod(sibling, 0o700)
        runtime.onProgress?.({ stage: "verifying" })
        await verify(command, asset.version, runtime.signal)
        runtime.signal.throwIfAborted()
        await publishBundle(stage, scope, asset)
        ready = await installed(scope, asset)
        if (!ready) throw new Error("The standalone Antigravity release could not be installed")
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    }
    runtime.signal.throwIfAborted()
    const temporary = join(root, ".active-" + randomUUID())
    try {
      await writeFile(temporary, JSON.stringify({ digest: ready.digest, version: ready.version }), {
        flag: "wx",
        mode: 0o600,
        signal: runtime.signal,
      })
      runtime.signal.throwIfAborted()
      await rename(temporary, join(root, "active.json"))
    } finally {
      await rm(temporary, { force: true })
    }
    return ready
  }
}

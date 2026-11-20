import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { openAcp, type AcpLaunch } from "@pigcode/acp-runtime"
import {
  acpRegistryAgentIdSchema,
  cliArgumentsSchema,
  type AcpRegistryEntry,
} from "@pigcode/contracts"
import {
  settingEnvironment,
  settingString,
  type AgentCliUpdatePlan,
  type AgentCliUpdateRuntime,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  cliUpdateAvailable,
  expandHome,
  findExecutable,
  runCliUpdate,
} from "@pigcode/plugin-sdk/node"
import { downloadRuntime, relativeArchivePath } from "./archive"

import { RegistryCatalog, launchDefaults, type Entry } from "./catalog"

const installationSchema = z.object({
  key: z.string().uuid(),
  version: z.string().min(1).max(128),
  command: z.string().min(1),
  ...launchDefaults,
})
type Installation = z.infer<typeof installationSchema>

function readId(settings: AgentSettingsValues): string | undefined {
  const value = settingString(settings, "registryId")
  return value === undefined ? undefined : acpRegistryAgentIdSchema.parse(value)
}

function registryDir(sharedDir: string, id: string) {
  return join(sharedDir, "registry", acpRegistryAgentIdSchema.parse(id))
}

function inside(directory: string, path: string) {
  const remainder = relative(directory, path)
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)
}

async function verifyExecutable(command: string) {
  if (!(await stat(command)).isFile())
    throw new Error("The ACP runtime did not provide an executable file")
  await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK)
}

async function installed(
  directory: string,
  receipt = "current.json",
): Promise<Installation | null> {
  const contents = await readFile(join(directory, receipt), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  if (contents === null) return null
  const value = installationSchema.parse(JSON.parse(contents))
  const command = join(directory, value.key, relativeArchivePath(value.command))
  return verifyExecutable(command).then(
    () => value,
    () => null,
  )
}

function versionReceipt(version: string) {
  return "prepared-" + createHash("sha256").update(version).digest("hex") + ".json"
}

async function cached(directory: string, version: string): Promise<Installation | null> {
  const prepared = await installed(directory, versionReceipt(version))
  if (prepared?.version === version) return prepared
  const current = await installed(directory)
  return current?.version === version ? current : null
}

async function publish(
  directory: string,
  receipt: string,
  record: Installation,
  signal: AbortSignal,
) {
  const temporary = join(directory, randomUUID() + ".tmp")
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(temporary, join(directory, receipt))
  } finally {
    await rm(temporary, { force: true })
  }
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv) {
  const expanded = expandHome(command)
  return /[/\\]/.test(expanded)
    ? resolve(expanded)
    : (findExecutable(expanded, undefined, env.PATH) ?? expanded)
}

export class RegistryRuntimes {
  readonly catalog: RegistryCatalog
  private readonly installing = new Map<string, { version: string; done: Promise<Installation> }>()
  private readonly shutdown = new AbortController()
  private readonly removing = new Set<string>()
  private readonly inUse = new Map<string, number>()

  constructor(private readonly fetcher: typeof fetch = fetch) {
    this.catalog = new RegistryCatalog(fetcher)
  }

  async prepareAgent(id: string, sharedDir: string): Promise<AcpRegistryEntry> {
    const directory = registryDir(sharedDir, id)
    const entry = await this.catalog.get(id, true)
    await this.stage(directory, entry, {}, { signal: this.shutdown.signal, onOutput: () => {} })
    return entry.metadata
  }

  async activate(sharedDir: string, id: string, version: string) {
    const directory = registryDir(sharedDir, id)
    const release = this.lease(directory)
    try {
      const record = await cached(directory, version)
      if (!record) throw new Error("The prepared ACP runtime is no longer available. Add it again.")
      const current = await installed(directory)
      if (current && (current.key === record.key || cliUpdateAvailable(version, current.version)))
        return
      await publish(directory, "current.json", record, this.shutdown.signal)
    } finally {
      release()
    }
  }

  async launch(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
    cwd: string,
  ): Promise<{
    launch: AcpLaunch
    directory?: string
  } | null> {
    const override = settingString(settings, "binaryPath")
    const userArgs = cliArgumentsSchema.parse(settings.arguments ?? [])
    const id = readId(settings)
    if (!id) {
      if (!override) return null
      const env = agentEnvironment(settingEnvironment(settings))
      return { launch: { command: resolveCommand(override, env), args: userArgs, env, cwd } }
    }
    const directory = registryDir(instance.sharedDir, id)
    const current = await installed(directory)
    if (!current && !override) return null
    const defaults = current ?? (await this.catalog.get(id)).source
    const env = agentEnvironment(
      settingEnvironment(settings),
      {},
      { ...process.env, ...defaults?.env },
    )
    const command = override
      ? resolveCommand(override, env)
      : join(directory, current!.key, relativeArchivePath(current!.command))
    const resolved = await realpath(command).catch(() => command)
    return {
      launch: { command, args: [...(defaults?.args ?? []), ...userArgs], cwd, env },
      ...(!override || inside(directory, resolved) ? { directory } : {}),
    }
  }

  lease(directory: string | undefined): () => void {
    if (!directory) return () => undefined
    if (this.removing.has(directory)) throw new Error("This ACP runtime is being removed")
    this.inUse.set(directory, (this.inUse.get(directory) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.inUse.get(directory) ?? 1) - 1
      if (remaining > 0) this.inUse.set(directory, remaining)
      else this.inUse.delete(directory)
    }
  }

  async prepare(
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
  ): Promise<AgentCliUpdatePlan> {
    const id = readId(settings)
    const override = settingString(settings, "binaryPath")
    const base: AgentCliUpdatePlan = {
      target: scope.instanceId,
      currentVersion: null,
      latestVersion: null,
      available: false,
      reason: "unsupported",
      command: null,
      verify: async () => null,
    }
    if (!id || override) return base
    const directory = registryDir(scope.sharedDir, id)
    const current = await installed(directory)
    const entry = await this.catalog.get(id)
    const verify = async () => (await installed(directory))?.version ?? null
    return {
      ...base,
      target: directory,
      currentVersion: current?.version ?? null,
      latestVersion: entry.metadata.version,
      available: !current || cliUpdateAvailable(current.version, entry.metadata.version),
      reason: null,
      concurrent: true,
      canRemove: current !== null,
      verify,
      run: (runtime) => this.update(directory, entry, settings, runtime),
    }
  }

  private async update(
    directory: string,
    entry: Entry,
    settings: AgentSettingsValues,
    runtime: AgentCliUpdateRuntime,
  ) {
    const release = this.lease(directory)
    const signal = AbortSignal.any([runtime.signal, this.shutdown.signal])
    try {
      const record = await this.stage(directory, entry, settings, runtime)
      signal.throwIfAborted()
      const rpc = openAcp({
        command: join(directory, record.key, relativeArchivePath(record.command)),
        cwd: join(directory, record.key),
        args: record.args ?? [],
        env: agentEnvironment(settingEnvironment(settings), {}, { ...process.env, ...record.env }),
      })
      try {
        await rpc.initialize(signal)
      } finally {
        await rpc.close()
      }
      await publish(directory, "current.json", record, signal)
    } finally {
      release()
    }
  }

  private async stage(
    directory: string,
    entry: Entry,
    settings: AgentSettingsValues,
    runtime: AgentCliUpdateRuntime,
  ): Promise<Installation> {
    this.shutdown.signal.throwIfAborted()
    if (this.removing.has(directory)) throw new Error("This ACP runtime is being removed")
    const pending = this.installing.get(directory)
    if (pending) {
      if (pending.version === entry.metadata.version) return pending.done
      await pending.done.catch(() => undefined)
      return this.stage(directory, entry, settings, runtime)
    }
    const signal = AbortSignal.any([this.shutdown.signal, runtime.signal])
    const done = this.writeInstallation(directory, entry, settings, { ...runtime, signal }).finally(
      () => this.installing.delete(directory),
    )
    this.installing.set(directory, { version: entry.metadata.version, done })
    return done
  }

  private async writeInstallation(
    directory: string,
    entry: Entry,
    settings: AgentSettingsValues,
    runtime: AgentCliUpdateRuntime,
  ) {
    runtime.signal.throwIfAborted()
    const previous = await cached(directory, entry.metadata.version)
    if (previous) return previous
    const key = randomUUID()
    const destination = join(directory, key)
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      const signal = runtime.signal
      const env = agentEnvironment(settingEnvironment(settings))
      const command = await this.installExecutable(destination, entry, env, runtime)
      runtime.onProgress?.({ stage: "verifying" })
      await verifyExecutable(command)
      const record: Installation = {
        key,
        version: entry.metadata.version,
        command: command.slice(destination.length + 1),
        ...(entry.source.args ? { args: entry.source.args } : {}),
        ...(entry.source.env ? { env: entry.source.env } : {}),
      }
      await publish(directory, versionReceipt(entry.metadata.version), record, signal)
      return record
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  }

  private async installExecutable(
    destination: string,
    entry: Entry,
    env: NodeJS.ProcessEnv,
    runtime: AgentCliUpdateRuntime,
  ): Promise<string> {
    runtime.onOutput(`Installing ${entry.metadata.name} ${entry.metadata.version}\n`)
    runtime.onProgress?.({ stage: "downloading" })
    const source = entry.source
    if ("archive" in source) {
      return downloadRuntime(
        this.fetcher,
        { url: source.archive, digest: source.sha256, command: source.cmd },
        destination,
        runtime,
      )
    }
    if (entry.metadata.distribution === "npx") {
      // npm 的 bin 使用安装目录里的同一版本，工作区中的同名依赖不会参与选择。
      const match = /^((?:@[\w.-]+\/)?[\w.-]+)@\d[^/\s]*$/.exec(source.package)
      if (!match?.[1]) throw new Error("ACP Registry npm runtime needs a pinned package version")
      const npm = findExecutable("npm", undefined, env.PATH)
      if (!npm) throw new Error("Install npm before installing this ACP runtime")
      await runCliUpdate(
        npm,
        [
          "install",
          "--prefix",
          destination,
          "--no-save",
          "--no-audit",
          "--no-fund",
          source.package,
        ],
        env,
        runtime,
      )
      const pkg = JSON.parse(
        await readFile(join(destination, "node_modules", match[1], "package.json"), "utf8"),
      ) as { bin?: string | Record<string, string> }
      const defaultName = basename(match[1])
      const names = typeof pkg.bin === "string" ? [defaultName] : Object.keys(pkg.bin ?? {})
      const name = names.includes(defaultName)
        ? defaultName
        : names.length === 1
          ? names[0]
          : undefined
      if (!name || !/^[\w.-]+$/.test(name))
        throw new Error("Could not identify the npm runtime executable")
      return join(
        destination,
        "node_modules",
        ".bin",
        process.platform === "win32" ? name + ".cmd" : name,
      )
    }
    const match = /^([\w.-]+)(?:==|@)([\w.+-]+)$/.exec(source.package)
    if (!match?.[1] || !match[2])
      throw new Error("ACP Registry Python runtime needs a pinned version")
    const uv = findExecutable("uv", undefined, env.PATH)
    if (!uv) throw new Error("Install uv before installing this ACP runtime")
    const bin = join(destination, "bin")
    await runCliUpdate(
      uv,
      ["tool", "install", `${match[1]}==${match[2]}`],
      {
        ...env,
        UV_TOOL_DIR: join(destination, "tools"),
        UV_TOOL_BIN_DIR: bin,
      },
      runtime,
    )
    const names = await readdir(bin)
    const preferred = process.platform === "win32" ? match[1] + ".exe" : match[1]
    const command = names.includes(preferred)
      ? preferred
      : names.length === 1
        ? names[0]
        : undefined
    if (!command) throw new Error("Could not identify the uv runtime executable")
    return join(bin, command)
  }

  async remove(
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
    configured: readonly AgentSettingsValues[],
  ) {
    const id = readId(settings)
    if (!id) throw new Error("Only managed ACP runtimes can be removed")
    const directory = registryDir(scope.sharedDir, id)
    if (this.inUse.has(directory) || this.installing.has(directory) || this.removing.has(directory))
      throw new Error("Close sessions using this ACP runtime before removing it")
    this.removing.add(directory)
    try {
      for (const values of configured) {
        const override = settingString(values, "binaryPath")
        if (!override) continue
        const env = agentEnvironment(settingEnvironment(values))
        const command = resolveCommand(override, env)
        const resolved = await realpath(command).catch(() => command)
        if (inside(directory, command) || inside(directory, resolved))
          throw new Error("Clear executable overrides using this ACP runtime before removing it")
      }
      await rm(directory, { recursive: true, force: true })
    } finally {
      this.removing.delete(directory)
    }
  }

  async close() {
    this.shutdown.abort()
    await Promise.allSettled([...this.installing.values()].map((item) => item.done))
  }
}

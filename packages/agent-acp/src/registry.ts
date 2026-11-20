import { randomUUID } from "node:crypto"
import { access, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { openAcp, type AcpLaunch } from "@pigcode/acp-runtime"
import { cliArgumentsSchema, type AcpRegistryEntry } from "@pigcode/contracts"
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

const registryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const registryId = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/)
const version = z.string().max(128).min(1)
const defaults = {
  args: cliArgumentsSchema.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
}
const binaryDistribution = z.object({
  ...defaults,
  archive: z.url({ protocol: /^https$/ }),
  cmd: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
})
const packageDistribution = z.object({ ...defaults, package: z.string().max(512) })
const agentEntry = z.object({
  id: registryId,
  name: z.string().min(1).max(160),
  version,
  description: z.string().max(1024),
  license: z.string().max(160).optional(),
  distribution: z.object({
    binary: z.record(z.string(), binaryDistribution).optional(),
    npx: packageDistribution.optional(),
    uvx: packageDistribution.optional(),
  }),
})
type Binary = z.infer<typeof binaryDistribution>
type Package = z.infer<typeof packageDistribution>

type Entry = AcpRegistryEntry & { source: Binary | Package }
const installationSchema = z.object({
  key: z.string().uuid(),
  version,
  command: z.string().min(1),
  ...defaults,
})
type Installation = z.infer<typeof installationSchema>

function readId(settings: AgentSettingsValues): string | undefined {
  const value = settingString(settings, "registryId")
  return value === undefined ? undefined : registryId.parse(value)
}

function registryDir(instance: AgentInstanceContext, id: string) {
  return join(instance.sharedDir, "registry", id)
}

function inside(directory: string, path: string) {
  const remainder = relative(directory, path)
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)
}

function asEntry(raw: unknown): Entry | undefined {
  const value = agentEntry.safeParse(raw)
  if (!value.success) return undefined
  const { distribution, license, ...agent } = value.data
  const os = process.platform === "win32" ? "windows" : process.platform
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  const binary = distribution.binary?.[`${os}-${arch}`]
  const source = binary ?? distribution.npx ?? distribution.uvx
  if (!source) return undefined
  return {
    ...agent,
    ...(license ? { license } : {}),
    distribution: binary ? "binary" : distribution.npx ? "npx" : "uvx",
    source,
  }
}

async function installed(directory: string): Promise<Installation | null> {
  const contents = await readFile(join(directory, "current.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  if (contents === null) return null
  const value = installationSchema.parse(JSON.parse(contents))
  const command = join(directory, value.key, relativeArchivePath(value.command))
  return access(command).then(
    () => value,
    () => null,
  )
}

export function resolveCommand(command: string, env: NodeJS.ProcessEnv) {
  const expanded = expandHome(command)
  return /[/\\]/.test(expanded)
    ? resolve(expanded)
    : (findExecutable(expanded, undefined, env.PATH) ?? expanded)
}

export class RegistryRuntimes {
  private cache?: { deadline: number; items: Promise<Map<string, Entry>> }
  private readonly modifying = new Set<string>()
  private readonly removing = new Set<string>()
  private readonly inUse = new Map<string, number>()

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private catalog() {
    if (this.cache && this.cache.deadline > Date.now()) return this.cache.items
    const items = (async () => {
      const response = await this.fetcher(registryUrl, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error("Could not load ACP Registry")
      const { agents } = z
        .object({ agents: z.array(z.unknown()).max(2_000) })
        .parse(await response.json())
      const entries = agents.flatMap((item) => asEntry(item) ?? [])
      return new Map(entries.map((entry) => [entry.id, entry]))
    })()
    this.cache = { deadline: Date.now() + 60_000, items }
    void items.catch(() => {
      if (this.cache?.items === items) delete this.cache
    })
    return items
  }

  async list(): Promise<AcpRegistryEntry[]> {
    const catalog = await this.catalog()
    return [...catalog.values()].map(
      ({ id, name, version, description, license, distribution }) => ({
        id,
        name,
        version,
        description,
        ...(license ? { license } : {}),
        distribution,
      }),
    )
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
    const directory = registryDir(instance, id)
    const current = await installed(directory)
    if (!current && !override) return null
    const defaults = current ?? (await this.catalog()).get(id)?.source
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
    const directory = registryDir(scope, id)
    const current = await installed(directory)
    const entry = (await this.catalog()).get(id)
    if (!entry) throw new Error("This ACP Registry agent has no runtime for this platform")
    const verify = async () => (await installed(directory))?.version ?? null
    return {
      ...base,
      target: directory,
      currentVersion: current?.version ?? null,
      latestVersion: entry.version,
      available: !current || cliUpdateAvailable(current.version, entry.version),
      reason: null,
      concurrent: true,
      canRemove: current !== null,
      verify,
      run: (runtime) => this.install(directory, entry, settings, runtime),
    }
  }

  private async install(
    directory: string,
    entry: Entry,
    settings: AgentSettingsValues,
    runtime: AgentCliUpdateRuntime,
  ) {
    if (this.modifying.has(directory))
      throw new Error("An ACP runtime operation is already running")
    this.modifying.add(directory)
    const key = randomUUID()
    const destination = join(directory, key)
    try {
      await mkdir(destination, { recursive: true, mode: 0o700 })
      const signal = runtime.signal
      const env = agentEnvironment(settingEnvironment(settings))
      const command = await this.installExecutable(destination, entry, env, runtime)
      runtime.onProgress?.({ stage: "verifying" })
      const rpc = openAcp({
        command,
        cwd: destination,
        args: entry.source.args ?? [],
        env: { ...env, ...entry.source.env },
      })
      try {
        await rpc.initialize(signal)
      } finally {
        await rpc.close()
      }
      const record: Installation = {
        key,
        version: entry.version,
        command: command.slice(destination.length + 1),
        ...(entry.source.args ? { args: entry.source.args } : {}),
        ...(entry.source.env ? { env: entry.source.env } : {}),
      }
      const next = join(destination, "current.json")
      await writeFile(next, JSON.stringify(record), { mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(next, join(directory, "current.json"))
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    } finally {
      this.modifying.delete(directory)
    }
  }

  private async installExecutable(
    destination: string,
    entry: Entry,
    env: NodeJS.ProcessEnv,
    runtime: AgentCliUpdateRuntime,
  ): Promise<string> {
    runtime.onOutput(`Installing ${entry.name} ${entry.version}\n`)
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
    if (entry.distribution === "npx") {
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
    const directory = registryDir(scope, id)
    if (this.inUse.has(directory) || this.modifying.has(directory))
      throw new Error("Close sessions using this ACP runtime before removing it")
    this.modifying.add(directory)
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
      this.modifying.delete(directory)
    }
  }
}

/**
 * 插件的安装与更新：本地目录、npm 包与 tarball、GitHub 仓库、git 仓库、https 上的 tar.gz，以及插件市场里的一项。
 * 远程来源先下载到临时目录，再和本地目录一样复制进 profile 的 `node_modules`；装好的条目连同来源写进 `plugins.yml`，
 * 更新时按来源重新安装。
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parsePluginManifest, type PluginManifest } from "@pigcode/plugin-sdk"
import { defaultFetcher } from "./plugin-download"
import {
  pluginIdOf,
  readManifestAt,
  readPluginList,
  readPluginRecords,
  toEnv,
  writePluginList,
  type InstalledPluginEntry,
  type PluginEnv,
  type PluginEnvInput,
  type PluginOrigin,
} from "./plugin-manager"
import {
  entryPluginSource,
  marketplaceSourceType,
  refreshMarketplace,
  resolveMarketplaceEntry,
} from "./plugin-marketplace"
import {
  defaultPnpmRunner,
  ensureProfilePackage,
  packageNameFromSpec,
  readProfilePackage,
  resolveInstalledName,
  type PnpmRunner,
} from "./plugin-npm"
import {
  defaultGitRunner,
  githubTokenFromEnv,
  materializeSource,
  parsePluginSpec,
  type PluginSource,
  type SourceIo,
} from "./plugin-sources"
import { compileTypeScriptPlugin } from "./plugin-typescript"

/** 内置插件的包名不能再从外部安装一份。 */
async function assertNotBuiltin(env: PluginEnv, name: string): Promise<void> {
  for (const dir of env.builtin) {
    const { manifest } = await readManifestAt(dir)
    if (manifest?.name === name) throw new Error(`PLUGIN_BUILTIN: ${name} is built into Pigcode`)
  }
}

/** 写入条目时的选项：来源，以及更新时保留原来的停用状态。 */
interface EntryOptions {
  origin?: PluginOrigin | undefined
  keepDisabled?: boolean | undefined
}

/**
 * 把 manifest 对应的条目写入插件列表；同 id 条目原位替换，避免重复。重装和更新保留原来的配置；
 * 安装等于启用，更新保留原来的启停状态。
 */
async function addPluginEntry(
  env: PluginEnv,
  manifest: PluginManifest,
  options: EntryOptions = {},
): Promise<InstalledPluginEntry> {
  const id = pluginIdOf(manifest)
  const list = await readPluginList(env.profileDir)
  const index = list.findIndex((item) => item.id === id)
  const previous = index === -1 ? undefined : list[index]
  const origin = options.origin ?? previous?.origin
  const entry: InstalledPluginEntry = {
    id,
    name: manifest.name,
    config: previous?.config ?? {},
    disabled: options.keepDisabled ? previous?.disabled === true : false,
    ...(origin ? { origin } : {}),
  }
  if (index === -1) list.push(entry)
  else list[index] = entry
  await ensureProfilePackage(env.profileDir)
  await writePluginList(env.profileDir, list)
  return entry
}

/** 安装来源里这个目录是不是插件：不是时说清楚它是什么（插件市场，或者普通目录）。 */
async function readPluginDir(dir: string): Promise<PluginManifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
  } catch {
    for (const relative of [join(".pigcode-plugin", "marketplace.json"), "marketplace.json"]) {
      const found = await readFile(join(dir, relative), "utf8").then(
        () => true,
        () => false,
      )
      if (found)
        throw new Error("PLUGIN_SOURCE_IS_MARKETPLACE: this source is a plugin marketplace")
    }
    throw new Error("PLUGIN_SOURCE_NOT_PLUGIN: no package.json in this source")
  }
  if (!raw || typeof raw !== "object" || !("pigcode" in raw)) {
    throw new Error("PLUGIN_SOURCE_NOT_PLUGIN: package.json has no pigcode field")
  }
  return parsePluginManifest(raw)
}

/** 本地安装的选项：来源、要求的包名（市场条目），以及更新时保留停用状态。 */
export interface LocalInstallOptions extends EntryOptions {
  expectedName?: string | undefined
}

/** 校验并复制本地插件目录到 profile，随后写入启用的条目。 */
export async function installLocalPlugin(
  input: PluginEnvInput,
  sourceDir: string,
  options: LocalInstallOptions = {},
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const manifest = await readPluginDir(sourceDir)
  if (options.expectedName && manifest.name !== options.expectedName) {
    throw new Error(
      `PLUGIN_NAME_MISMATCH: the marketplace lists ${options.expectedName} but the package is ${manifest.name}`,
    )
  }
  await assertNotBuiltin(env, manifest.name)
  const target = join(env.profileDir, "node_modules", manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, {
    recursive: true,
    filter: (path) => !/[\\/]\.git$/.test(path),
  })
  await compileTypeScriptPlugin(target)
  return addPluginEntry(env, manifest, {
    origin: options.origin ?? { kind: "local", path: sourceDir },
    keepDisabled: options.keepDisabled,
  })
}

/** 下载与克隆的默认实现：Electron 的 net、系统 git、环境变量里的 GitHub 令牌。 */
export function defaultSourceIo(): SourceIo {
  return { fetcher: defaultFetcher(), runGit: defaultGitRunner, githubToken: githubTokenFromEnv() }
}

/** 从一个来源安装：npm 交给 pnpm，本地目录直接复制，远程来源先下载到临时目录。 */
async function installFromSource(
  env: PluginEnv,
  source: PluginSource,
  runPnpm: PnpmRunner,
  io: SourceIo,
  options: LocalInstallOptions,
): Promise<InstalledPluginEntry> {
  if (source.kind === "npm") return installNpmPlugin(env, source.spec, runPnpm, options)
  if (source.kind === "local")
    return installLocalPlugin(env, source.path, { ...options, origin: options.origin ?? source })
  const materialized = await materializeSource(source, io)
  try {
    return await installLocalPlugin(env, materialized.dir, {
      ...options,
      origin: options.origin ?? source,
    })
  } finally {
    await materialized.cleanup()
  }
}

/**
 * 安装插件：本地目录复制进 profile；GitHub 仓库、git 仓库与 https 上的 tar.gz 先下载到临时目录再复制；
 * 其余 spec（npm 包名/版本、本地 tarball）交给 `pnpm add`。runner 与 io 由调用方注入，测试不联网。
 */
export async function installPlugin(
  input: PluginEnvInput,
  spec: string,
  runPnpm: PnpmRunner = defaultPnpmRunner,
  io: SourceIo = defaultSourceIo(),
): Promise<InstalledPluginEntry> {
  return installFromSource(toEnv(input), parsePluginSpec(spec), runPnpm, io, {})
}

/** 安装插件市场里的一项；装好的包名必须和条目一致。 */
export async function installFromMarketplace(
  input: PluginEnvInput,
  marketplace: string,
  plugin: string,
  runPnpm: PnpmRunner = defaultPnpmRunner,
  io: SourceIo = defaultSourceIo(),
  keepDisabled = false,
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const { entry, root } = await resolveMarketplaceEntry(env.profileDir, marketplace, plugin)
  return installFromSource(env, entryPluginSource(entry, root), runPnpm, io, {
    origin: { kind: "marketplace", marketplace, plugin },
    expectedName: entry.name,
    keepDisabled,
  })
}

/**
 * 更新用户安装的插件：按记下的来源重新安装，保留配置与启停状态。从远程市场装的先刷新市场，
 * 拿到最新的条目再装。没有来源记录（旧版本装的）或内置插件不能更新。
 */
export async function updatePlugin(
  input: PluginEnvInput,
  id: string,
  runPnpm: PnpmRunner = defaultPnpmRunner,
  io: SourceIo = defaultSourceIo(),
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const record = (await readPluginRecords(env)).find((item) => item.id === id)
  if (!record) throw new Error(`plugin not found: ${id}`)
  if (record.builtin) throw new Error(`PLUGIN_BUILTIN: ${record.name} updates with Pigcode`)
  const origin = record.origin
  if (!origin) throw new Error(`PLUGIN_ORIGIN_UNKNOWN: ${record.name} has no recorded source`)
  if (origin.kind === "marketplace") {
    const type = await marketplaceSourceType(env.profileDir, origin.marketplace)
    if (type === null) throw new Error(`PLUGIN_MARKETPLACE_REMOVED: ${origin.marketplace}`)
    if (type !== "directory" && type !== "file") {
      const refreshed = await refreshMarketplace(env.profileDir, origin.marketplace, io)
      if (refreshed.error) throw new Error(refreshed.error)
    }
    return installFromMarketplace(env, origin.marketplace, origin.plugin, runPnpm, io, true)
  }
  return installFromSource(env, origin, runPnpm, io, {
    origin,
    expectedName: record.name,
    keepDisabled: true,
  })
}

/** npm 包名、版本或本地 tarball：交给 pnpm 装进 profile。 */
async function installNpmPlugin(
  env: PluginEnv,
  spec: string,
  runPnpm: PnpmRunner,
  options: LocalInstallOptions,
): Promise<InstalledPluginEntry> {
  const fromSpec = packageNameFromSpec(spec)
  if (fromSpec) await assertNotBuiltin(env, fromSpec)
  // pnpm add 需要 profile 中已有 package.json 作为安装作用域。
  await ensureProfilePackage(env.profileDir)
  const before = await readProfilePackage(env.profileDir)
  await runPnpm(["add", spec, "--dir", env.profileDir])
  const after = await readProfilePackage(env.profileDir)
  const name = resolveInstalledName(spec, before.dependencies ?? {}, after.dependencies ?? {})
  const packageDir = join(env.profileDir, "node_modules", name)
  const manifest = parsePluginManifest(
    JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")),
  )
  if (options.expectedName && manifest.name !== options.expectedName) {
    throw new Error(
      `PLUGIN_NAME_MISMATCH: expected ${options.expectedName} but the package is ${manifest.name}`,
    )
  }
  await assertNotBuiltin(env, manifest.name)
  await compileTypeScriptPlugin(packageDir)
  return addPluginEntry(env, manifest, {
    origin: options.origin ?? { kind: "npm", spec },
    keepDisabled: options.keepDisabled,
  })
}

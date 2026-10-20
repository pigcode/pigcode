/** 本地插件安装、启停与 boot graph 构建；M0 只支持本地目录。 */
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse, stringify } from "yaml"
import { pluginManifestSchema, type PluginManifest } from "@pigcode/plugin-sdk"

/** profile 中记录的单条已安装插件。 */
export interface InstalledPluginEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
}

/** 渲染进程启动插件所需的单条 boot graph 记录。 */
export interface BootGraphEntry {
  id: string
  revision: string
  url: string
  inject: string[]
}

/** profile 文件名；与 kernel 的 profile 加载约定保持一致。 */
const PROFILE_FILE = "desktop.yml"

/** 读取 profile；文件不存在时从空插件列表开始。 */
async function readProfile(profileDir: string): Promise<{ plugins: InstalledPluginEntry[] }> {
  const path = join(profileDir, PROFILE_FILE)
  try {
    return parse(await readFile(path, "utf8")) as { plugins: InstalledPluginEntry[] }
  } catch {
    return { plugins: [] }
  }
}

/** 写回 profile，必要时先创建目录。 */
async function writeProfile(
  profileDir: string,
  profile: { plugins: InstalledPluginEntry[] },
): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, PROFILE_FILE), stringify(profile), "utf8")
}

/** 校验并复制本地插件到 profile，随后写入启用的条目。 */
export async function installLocalPlugin(
  profileDir: string,
  sourceDir: string,
): Promise<InstalledPluginEntry> {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")),
  )
  const target = join(profileDir, "node_modules", manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, { recursive: true })
  const entry: InstalledPluginEntry = {
    id: `${manifest.pigcode.kind}.${manifest.name}`,
    name: manifest.name,
    config: {},
    disabled: false,
  }
  const profile = await readProfile(profileDir)
  profile.plugins = [...profile.plugins.filter((item) => item.id !== entry.id), entry]
  await writeProfile(profileDir, profile)
  return entry
}

/** 切换插件的 disabled 标记。 */
export async function setPluginEnabled(
  profileDir: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const profile = await readProfile(profileDir)
  const entry = profile.plugins.find((item) => item.id === id)
  if (!entry) throw new Error(`plugin not found: ${id}`)
  entry.disabled = !enabled
  await writeProfile(profileDir, profile)
}

/** 为已启用且带 client 入口的插件生成启动图。 */
export async function buildBootGraph(profileDir: string): Promise<{ entries: BootGraphEntry[] }> {
  const profile = await readProfile(profileDir)
  const entries: BootGraphEntry[] = []
  for (const entry of profile.plugins) {
    if (entry.disabled) continue
    const manifest = await readManifest(profileDir, entry)
    if (!manifest.pigcode.client) continue
    const clientPath = join(profileDir, "node_modules", manifest.name, manifest.pigcode.client)
    const revision = createHash("sha256")
      .update(await readFile(clientPath))
      .digest("hex")
      .slice(0, 12)
    entries.push({
      id: entry.id,
      revision,
      url: `pigcode-plugin://plugins/${encodeURIComponent(manifest.name)}/client.js?rev=${revision}`,
      inject: manifest.pigcode.inject,
    })
  }
  return { entries }
}

/** 读取已安装插件目录中的 manifest 并校验。 */
async function readManifest(
  profileDir: string,
  entry: InstalledPluginEntry,
): Promise<PluginManifest> {
  const path = join(profileDir, "node_modules", entry.name, "package.json")
  return pluginManifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
}

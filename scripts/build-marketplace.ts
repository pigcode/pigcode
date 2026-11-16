/** 构建官方目录与预编译插件包。发布目录可以已有上一版的制品，一个版本的制品保持不可变。 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  OFFICIAL_MARKETPLACE_BASE,
  OFFICIAL_MARKETPLACE_NAME,
} from "../marketplace/catalog-source.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const catalogDir = join(root, "marketplace")
const pluginRoot = join(catalogDir, "plugins")
const require = createRequire(join(catalogDir, "package.json"))

interface PluginPackage {
  name: string
  version: string
  description: string
  pigcode: { displayName: string; host?: string; client?: string }
  marketplace: {
    publisherType: "official" | "community"
    author: string
    homepage?: string
    category: string
    displayName_i18n?: Record<string, string>
    description_i18n?: Record<string, string>
    licenses?: string[]
  }
}

async function buildPluginListing(dir: string, output: string) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as PluginPackage
  const { marketplace, ...manifest } = pkg
  const { licenses = [], ...listing } = marketplace
  execFileSync(process.execPath, [join(root, "scripts/build-plugin.ts")], {
    cwd: dir,
    stdio: "inherit",
  })
  const stage = await mkdtemp(join(tmpdir(), "pigcode-marketplace-"))
  try {
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
    await cp(join(dir, "dist"), join(stage, "dist"), { recursive: true })
    await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"))
    for (const dependency of licenses) {
      const location = dirname(require.resolve(`${dependency}/package.json`))
      await copyFile(join(location, "LICENSE"), join(stage, `LICENSE-${dependency}.txt`))
    }
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
        cwd: stage,
        encoding: "utf8",
        shell: process.platform === "win32",
      }),
    ) as { filename: string }[]
    if (!pack) throw new Error(`没有生成 ${pkg.name} 的制品`)
    const archive = join(stage, pack.filename)
    const bytes = await readFile(archive)
    const target = join(output, "packages", pack.filename)
    const published = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (published && !published.equals(bytes))
      throw new Error(`${pkg.name} ${pkg.version} 的制品已发布，请提高版本号`)
    if (!published) await copyFile(archive, target)
    return {
      name: pkg.name,
      displayName: pkg.pigcode.displayName,
      description: pkg.description,
      version: pkg.version,
      ...listing,
      source: {
        source: "url",
        url: `${OFFICIAL_MARKETPLACE_BASE}/packages/${pack.filename}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (!process.argv[2]) throw new Error("用法：pnpm marketplace:build <制品目录>")
const output = resolve(process.argv[2])
await mkdir(join(output, "packages"), { recursive: true })
const plugins = []
for (const dir of (await readdir(pluginRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))) {
  plugins.push(await buildPluginListing(join(pluginRoot, dir.name), output))
}
await writeFile(
  join(output, "marketplace.json"),
  JSON.stringify(
    {
      name: OFFICIAL_MARKETPLACE_NAME,
      displayName: "Pigcode",
      owner: "Pigcode",
      plugins,
    },
    null,
    2,
  ) + "\n",
)

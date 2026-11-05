#!/usr/bin/env node
/**
 * 生成安装包里的第三方许可证声明。
 *
 * MIT 要求分发时保留版权声明，架构文档 §15 也要求随分发保留 Cordis 和 dsh 的 MIT 声明。
 * 依赖清单取自 pnpm 的生产依赖（整个 workspace）：打包时 esbuild 会把它们打进 out/，
 * 所以不能只看 apps/desktop 自己的依赖。
 */
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** pnpm licenses list --prod --json 的输出。 */
export type LicenseInventory = Record<string, InventoryPackage[]>

export interface InventoryPackage {
  name: string
  versions: string[]
  paths: string[]
  license: string
}

/** 许可证文件名：LICENSE、LICENSE.md、COPYING、NOTICE 等。 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-.].*)?$/i

/** 没有许可证文本时，这些声明不算“知道许可证”。 */
const UNKNOWN = /^(unknown|unlicensed|see license in .+|none)?$/i

export interface NoticeEntry {
  name: string
  version: string
  license: string
  /** 许可证或版权声明的原文；没有文件时为空。 */
  texts: string[]
  /** package.json 里声明的作者和仓库，没有许可证文件时用来说明来源。 */
  author?: string
  repository?: string
}

/** 读出目录里所有许可证文件的正文，按文件名排序。 */
export function licenseTexts(dir: string, entries: string[] = listDir(dir)): string[] {
  return entries
    .filter((entry) => LICENSE_FILE.test(entry))
    .sort()
    .map((entry) => {
      const path = join(dir, entry)
      try {
        // 只有文件算数；有的包里有个同名的目录。
        if (!statSync(path).isFile()) return ""
        return readFileSync(path, "utf8").trim()
      } catch {
        return ""
      }
    })
    .filter((text) => text !== "")
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readManifest(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function repositoryOf(manifest: Record<string, unknown>): string | undefined {
  const repository = manifest.repository
  if (typeof repository === "string") return repository
  if (typeof repository === "object" && repository !== null) {
    const url = (repository as { url?: unknown }).url
    if (typeof url === "string") return url
  }
  const homepage = manifest.homepage
  return typeof homepage === "string" ? homepage : undefined
}

/**
 * 一个包的声明条目。找不到许可证文本、也没有可信的许可证声明时抛错：
 * 构建要停下来，不能悄悄漏掉一个依赖的版权声明。
 */
export function noticeEntry(pkg: InventoryPackage): NoticeEntry {
  const dir = pkg.paths[0] ?? ""
  const manifest = readManifest(dir)
  const texts = licenseTexts(dir)
  const declared = typeof manifest.license === "string" ? manifest.license : pkg.license
  if (texts.length === 0 && UNKNOWN.test(declared ?? "")) {
    throw new Error(`no license text or declaration for ${pkg.name}@${pkg.versions[0] ?? "?"}`)
  }
  const author = typeof manifest.author === "string" ? manifest.author : undefined
  const repository = repositoryOf(manifest)
  return {
    name: pkg.name,
    version: pkg.versions.join(", "),
    license: declared,
    texts,
    ...(author === undefined ? {} : { author }),
    ...(repository === undefined ? {} : { repository }),
  }
}

/** 清单里的每个包（每个版本算一条）都转成声明条目，按名称排序。 */
export function noticeEntries(inventory: LicenseInventory): NoticeEntry[] {
  // 同一个包可能装在多个路径下；名称和版本相同，声明只用一份。
  return Object.values(inventory)
    .flat()
    .map(noticeEntry)
    .sort((left, right) =>
      left.name === right.name
        ? left.version.localeCompare(right.version)
        : left.name.localeCompare(right.name),
    )
}

/** 生成声明文件：先是 Pigcode 自己的许可证，再是每个依赖。 */
export function renderNotices(input: { ownLicense: string; entries: NoticeEntry[] }): string {
  const parts = [
    "Pigcode",
    "=======",
    "",
    "Pigcode is licensed under the MIT License:",
    "",
    input.ownLicense.trim(),
    "",
    `Third-party software (${String(input.entries.length)} packages)`,
    "=".repeat(40),
    "",
    "Pigcode includes the following third-party software. Each entry keeps the",
    "license or copyright notice its package ships. Packages without a license",
    "file are listed with the license declared in their package.json.",
    "",
  ]
  for (const entry of input.entries) {
    parts.push("-".repeat(40), `${entry.name} ${entry.version}`, `License: ${entry.license}`)
    if (entry.author) parts.push(`Author: ${entry.author}`)
    if (entry.repository) parts.push(`Source: ${entry.repository}`)
    parts.push("")
    if (entry.texts.length > 0) parts.push(...entry.texts.join("\n\n").split("\n"), "")
    else parts.push("(no license file in the package)", "")
  }
  return `${parts.join("\n").trimEnd()}\n`
}

/** 读生产依赖清单。在 workspace 根目录运行 pnpm。 */
export function readInventory(cwd: string): LicenseInventory {
  const output = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(output) as LicenseInventory
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, "apps/desktop/build")

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const ownLicense = readFileSync(join(root, "LICENSE"), "utf8")
  const notices = renderNotices({ ownLicense, entries: noticeEntries(readInventory(root)) })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "THIRD_PARTY_NOTICES.txt"), notices)
  copyFileSync(join(root, "LICENSE"), join(target, "LICENSE.txt"))
  console.log(`notices: ${String(notices.split("\n").length)} lines in apps/desktop/build`)
}

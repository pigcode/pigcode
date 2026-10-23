/**
 * TypeScript 插件：安装后把包内的 .ts/.mts 源码转成同名 .mjs，并把入口改指向转换结果。
 *
 * Node 只对 node_modules 之外的文件做类型剥离，而插件都装在 profile/node_modules 下，
 * 所以安装时用 Node 内置的 stripTypeScriptTypes 先转一遍；Host 与渲染进程只加载 .mjs。
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { join, relative } from "node:path"

/** 需要转换的源码；声明文件只有类型，没有运行时内容。 */
const SOURCE_FILE = /\.m?ts$/
const DECLARATION_FILE = /\.d\.m?ts$/

/** 相对路径的 import/export/动态 import，指向 .ts 或 .mts 文件。 */
const RELATIVE_TS_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*?)\.m?ts\2/g

/** 判断 manifest 里的入口是否是 TypeScript 源码。 */
export function isTypeScriptEntry(entry: unknown): entry is string {
  return typeof entry === "string" && SOURCE_FILE.test(entry) && !DECLARATION_FILE.test(entry)
}

/** TypeScript 入口转换后的 .mjs 路径；其他入口原样返回。 */
export function compiledEntry(entry: string): string {
  return isTypeScriptEntry(entry) ? entry.replace(SOURCE_FILE, ".mjs") : entry
}

/** 把源码里指向 .ts/.mts 的相对 import 改成转换后的 .mjs。 */
export function rewriteRelativeImports(code: string): string {
  return code.replace(
    RELATIVE_TS_IMPORT,
    (_match, keyword: string, quote: string, path: string) => {
      return `${keyword}${quote}${path}.mjs${quote}`
    },
  )
}

/** 转换一个 TypeScript 文件；enum、namespace 等需要改写的语法也一并处理。 */
export function transpileTypeScript(source: string, fileName: string): string {
  try {
    return rewriteRelativeImports(stripTypeScriptTypes(source, { mode: "transform" }))
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error)
    throw new Error(`PLUGIN_TYPESCRIPT_INVALID: ${fileName}: ${reason}`)
  }
}

/** 递归列出包内的 TypeScript 源码；跳过依赖目录与隐藏目录。 */
async function listSources(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listSources(path)))
    else if (entry.isFile() && isTypeScriptEntry(entry.name)) files.push(path)
  }
  return files
}

/** package.json 中会被 Host 或渲染进程加载的入口字段。 */
interface EntryFields {
  main?: unknown
  exports?: unknown
  pigcode?: { host?: unknown; client?: unknown } & Record<string, unknown>
}

/** 改写入口字段；返回是否有入口指向 TypeScript。 */
function rewriteEntries(manifest: EntryFields): boolean {
  let changed = false
  const swap = (value: unknown): unknown => {
    if (!isTypeScriptEntry(value)) return value
    changed = true
    return compiledEntry(value)
  }
  if (manifest.main !== undefined) manifest.main = swap(manifest.main)
  if (typeof manifest.exports === "string") manifest.exports = swap(manifest.exports)
  if (manifest.pigcode) {
    if (manifest.pigcode.host !== undefined) manifest.pigcode.host = swap(manifest.pigcode.host)
    if (manifest.pigcode.client !== undefined) {
      manifest.pigcode.client = swap(manifest.pigcode.client)
    }
  }
  return changed
}

/**
 * 转换已安装插件包里的 TypeScript：入口都不是 .ts 时什么也不做。
 * 转换写在 profile 里的副本上，插件源目录保持不变。返回是否做了转换。
 */
export async function compileTypeScriptPlugin(packageDir: string): Promise<boolean> {
  const manifestPath = join(packageDir, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EntryFields
  if (!rewriteEntries(manifest)) return false
  for (const file of await listSources(packageDir)) {
    const output = transpileTypeScript(await readFile(file, "utf8"), relative(packageDir, file))
    await writeFile(compiledEntry(file), output, "utf8")
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return true
}

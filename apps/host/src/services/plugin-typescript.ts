/**
 * TypeScript 插件：安装后把包内的 .ts/.tsx/.mts 源码转成同名 .mjs，并把入口改指向转换结果。
 *
 * Node 的类型剥离不认 JSX，插件又都装在 profile/node_modules 下，所以安装时用 esbuild 先转一遍：
 * TSX 用自动 JSX runtime（`jsx: "automatic"`），编译结果 import 的是 `react/jsx-runtime`，
 * 运行时由宿主的共享模块提供（ADR-0002）。Host 与渲染进程只加载 .mjs。
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

/** 需要转换的源码；声明文件只有类型，没有运行时内容。 */
const SOURCE_FILE = /\.m?tsx?$/
const DECLARATION_FILE = /\.d\.m?tsx?$/

/** 相对路径的 import/export/动态 import，指向 .ts/.tsx/.mts 文件。 */
const RELATIVE_TS_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*?)\.m?tsx?\2/g

/** 判断 manifest 里的入口是否是 TypeScript 源码。 */
export function isTypeScriptEntry(entry: unknown): entry is string {
  return typeof entry === "string" && SOURCE_FILE.test(entry) && !DECLARATION_FILE.test(entry)
}

/** TypeScript 入口转换后的 .mjs 路径；其他入口原样返回。 */
export function compiledEntry(entry: string): string {
  return isTypeScriptEntry(entry) ? entry.replace(SOURCE_FILE, ".mjs") : entry
}

/** 把源码里指向 .ts/.tsx/.mts 的相对 import 改成转换后的 .mjs。 */
export function rewriteRelativeImports(code: string): string {
  return code.replace(
    RELATIVE_TS_IMPORT,
    (_match, keyword: string, quote: string, path: string) => {
      return `${keyword}${quote}${path}.mjs${quote}`
    },
  )
}

/** 文件扩展名决定 esbuild 的 loader：只有 .tsx 才按 JSX 解析。 */
function loaderFor(fileName: string): "ts" | "tsx" {
  return fileName.endsWith("x") ? "tsx" : "ts"
}

/**
 * esbuild 的错误消息里，「Transform failed with N errors」只是标题，真正的原因和位置在后面的行。
 * 取第一条错误的原因和位置，插件页上才说得出改哪里；拿不到结构化信息时退回消息本身。
 */
function transformReason(error: unknown): string {
  const first = (error as { errors?: Array<{ text?: string; location?: { line?: number } }> })
    ?.errors?.[0]
  if (first?.text) {
    const line = first.location?.line
    return line === undefined ? first.text : `${first.text} (line ${line})`
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.split("\n").find((part) => part.trim() !== "") ?? message
}

/** 转换一个 TypeScript 文件；TSX 用自动 JSX runtime，enum、namespace 等语法也一并处理。 */
export async function transpileTypeScript(source: string, fileName: string): Promise<string> {
  // 按需加载 esbuild：它带着平台原生二进制，找不到时只该让这一次本地安装失败，
  // 不能让整个 Host 在启动时 import 失败。
  const { transform } = await import("esbuild")
  try {
    const result = await transform(source, {
      loader: loaderFor(fileName),
      format: "esm",
      target: "es2022",
      // 自动 runtime：编译成 `import { jsx } from "react/jsx-runtime"`，由宿主的共享模块解析。
      jsx: "automatic",
      jsxImportSource: "react",
      // 插件按包名 import，这些是宿主的共享模块，不能打进插件自己的文件；esbuild 只做转换、不做打包，
      // 所以这里不需要 external，import 原样留在输出里。
    })
    return rewriteRelativeImports(result.code)
  } catch (error) {
    throw new Error(`PLUGIN_TYPESCRIPT_INVALID: ${fileName}: ${transformReason(error)}`)
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
 * 转换已安装插件包里的 TypeScript：入口都不是 TypeScript 时什么也不做。
 * 转换写在 profile 里的副本上，插件源目录保持不变。返回是否做了转换。
 */
export async function compileTypeScriptPlugin(packageDir: string): Promise<boolean> {
  const manifestPath = join(packageDir, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EntryFields
  if (!rewriteEntries(manifest)) return false
  for (const file of await listSources(packageDir)) {
    const output = await transpileTypeScript(
      await readFile(file, "utf8"),
      relative(packageDir, file),
    )
    await writeFile(compiledEntry(file), output, "utf8")
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return true
}

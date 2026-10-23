/** 插件安装用到的 npm 作用域辅助：profile 的 package.json、pnpm 调用与包名识别。 */
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

/** npm 安装通过 pnpm 执行；单测注入 fake runner，不联网。 */
export type PnpmRunner = (args: string[]) => Promise<void>

const execFileAsync = promisify(execFile)

/** 默认 pnpm runner；PIGCODE_PNPM 可覆盖可执行文件路径。 */
export const defaultPnpmRunner: PnpmRunner = async (args) => {
  await execFileAsync(process.env.PIGCODE_PNPM ?? "pnpm", args)
}

/**
 * profile 目录本身就是 npm 包的安装作用域。
 * pnpm 安装会生成 package.json；本地目录安装也补一个最小文件，保持两种安装方式一致。
 */
export async function ensureProfilePackage(profileDir: string): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  try {
    await writeFile(
      join(profileDir, "package.json"),
      JSON.stringify({ name: "pigcode-profile", version: "0.0.0", private: true }, null, 2),
      { flag: "wx" },
    )
  } catch (error) {
    // 已存在时保持不变，避免覆盖 pnpm 维护的依赖列表。
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

/** 读取 profile 的 package.json；文件缺失或不可解析时视为空。 */
export async function readProfilePackage(
  profileDir: string,
): Promise<{ dependencies?: Record<string, string> }> {
  try {
    return JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
  } catch {
    return {}
  }
}

/** tarball 交给 pnpm 解包；只有普通本地目录才直接复制。 */
export function isTarballPath(path: string): boolean {
  return /\.(?:tgz|tar\.gz)$/i.test(path)
}

/** 从 npm spec 中去掉版本得到包名；scoped 包保留 @scope/ 前缀。 */
export function packageNameFromSpec(spec: string): string | null {
  const value = spec.replace(/^file:/, "")
  // 路径与 tarball 无法从字面推断包名，交给依赖差异识别。
  if (value.startsWith(".") || value.startsWith("/") || isTarballPath(value)) return null
  const separator = value.lastIndexOf("@")
  return separator > 0 ? value.slice(0, separator) : value
}

/**
 * 找出本次安装的包名：
 * 1. 优先取新增的依赖，避免 pnpm 按字母排序时误选已有的最后一个包；
 * 2. 重复安装没有新增依赖时，回退到从 spec 解析出的包名。
 */
export function resolveInstalledName(
  spec: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  const lastAdded = Object.keys(after)
    .filter((name) => !(name in before))
    .at(-1)
  if (lastAdded) return lastAdded
  const fromSpec = packageNameFromSpec(spec)
  if (fromSpec && fromSpec in after) return fromSpec
  throw new Error("installed package not found in profile dependencies")
}

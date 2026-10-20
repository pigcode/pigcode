/** 把相对路径解析到根目录内；越界、绝对路径与空路径都拒绝。 */
import { realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

/** 判断目标是否等于根目录或位于根目录之下。 */
function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return target.startsWith(prefix)
}

/** 词法解析相对路径；.. 逃逸、绝对路径与空路径都会抛错。 */
export function resolveInside(root: string, requestPath: string): string {
  if (requestPath.length === 0) throw new Error("path must not be empty")
  if (isAbsolute(requestPath)) throw new Error(`absolute path not allowed: ${requestPath}`)
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, requestPath)
  if (!isInside(normalizedRoot, target)) {
    throw new Error(`path escapes project: ${requestPath}`)
  }
  return target
}

/** 在词法校验后再解析符号链接，阻止链接把读取带到根目录之外。 */
export async function resolveRealInside(root: string, requestPath: string): Promise<string> {
  const target = resolveInside(root, requestPath)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`path escapes project: ${requestPath}`)
  }
  return realTarget
}

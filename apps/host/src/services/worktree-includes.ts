/** 将 .worktreeinclude 明确列出的 Git 忽略文件复制到新的 worktree。 */
import { constants } from "node:fs"
import { copyFile, lstat, mkdir } from "node:fs/promises"
import { dirname, relative } from "node:path"
import { resolveInside, resolveRealInside } from "./path-safety"
import { gitIgnored } from "./workspace-files"

const INCLUDE_FILE = ".worktreeinclude"

export async function copyWorktreeIncludes(
  source: string,
  target: string,
  git: (args: string[]) => Promise<string>,
): Promise<void> {
  const include = await lstat(resolveInside(source, INCLUDE_FILE)).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return null
    throw error
  })
  if (!include?.isFile()) return
  const output = await git([
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    `--exclude-from=${INCLUDE_FILE}`,
  ])
  const ignored = await gitIgnored(source, output.split("\0").filter(Boolean))
  if (!ignored) throw new Error(`Could not check Git ignore rules for ${INCLUDE_FILE}`)

  for (const name of ignored) {
    if (name.split("/").some((part) => part.toLowerCase() === ".git")) continue
    if (!(await lstat(resolveInside(source, name))).isFile()) continue
    await copyIncludedFile(
      target,
      await resolveRealInside(source, name),
      resolveInside(target, name),
    )
  }
}

async function copyIncludedFile(root: string, from: string, to: string): Promise<void> {
  const parent = dirname(to)
  // 在 mkdir 前确认最靠近目标的已有目录没有符号链接通向 worktree 外。
  let existing = parent
  while (existing !== root) {
    try {
      if (!(await lstat(existing)).isDirectory()) return
      await resolveRealInside(root, relative(root, existing))
      break
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error
      existing = dirname(existing)
    }
  }
  await mkdir(parent, { recursive: true })
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

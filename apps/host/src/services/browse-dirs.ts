/** 面向已授权桌面端的只读主机目录浏览服务：用于在远程电脑 / Linux NAS 上选择项目根目录。 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { HostBrowseDirEntry, HostBrowseDirsResult } from "@pigcode/contracts"

function safeRealpath(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function directoryHasChildren(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      if (entry.isDirectory()) return true
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(dirPath, entry.name)).isDirectory()) return true
        } catch {
          // broken symlink
        }
      }
    }
  } catch {
    // unreadable directory
  }
  return false
}

/** 列出指定路径（缺省为当前用户主目录）下的子目录，供远程主机添加项目使用。 */
export function browseHostDirectories(
  requestedPath?: string,
  homeOverride?: string,
): HostBrowseDirsResult {
  const homePath = safeRealpath(homeOverride ?? homedir())
  const trimmed = requestedPath?.trim()
  const rawTarget = trimmed ? (trimmed === "~" ? homePath : trimmed) : homePath
  const target = safeRealpath(rawTarget)

  const stats = statSync(target)
  if (!stats.isDirectory()) {
    throw new Error(`not a directory: ${target}`)
  }

  const rawParent = dirname(target)
  const parentPath = rawParent !== target ? rawParent : null

  const rawEntries = readdirSync(target, { withFileTypes: true })
  const dirs: HostBrowseDirEntry[] = []

  for (const entry of rawEntries) {
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(join(target, entry.name)).isDirectory()
      } catch {
        continue
      }
    }
    if (!isDir) continue
    const childPath = join(target, entry.name)
    dirs.push({
      name: entry.name,
      path: childPath,
      isGitRepo: existsSync(join(childPath, ".git")),
      hasChildren: directoryHasChildren(childPath),
    })
  }

  // 非隐藏文件夹按字母排在最前，隐藏目录排在末尾，方便用户直接找到代码目录。
  dirs.sort((a, b) => {
    const aHidden = a.name.startsWith(".")
    const bHidden = b.name.startsWith(".")
    if (aHidden !== bHidden) return aHidden ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  return {
    path: target,
    parentPath,
    homePath,
    entries: dirs,
  }
}

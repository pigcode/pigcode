/**
 * 手机端项目管理处理器：
 * - 浏览目录限定在电脑用户主目录 `~` 下，通过 realpath 防止符号链接逃逸，隐藏并拒绝敏感系统与凭据目录；
 * - 添加/重命名/移除项目复用桌面端 ProjectsService 与运行/终端清理语义，永不向手机端暴露原始系统绝对路径。
 */
import type { Context } from "cordis"
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import {
  MOBILE_PROJECT_BROWSE_LIMIT,
  MOBILE_PROJECT_SHORTCUT_LIMIT,
  isValidMobileHomeRelPath,
  mobileProjectAddParams,
  mobileProjectAddResult,
  mobileProjectBrowseDirsParams,
  mobileProjectBrowseDirsResult,
  mobileProjectManageListParams,
  mobileProjectManageListResult,
  mobileProjectMethods,
  mobileProjectRemoveParams,
  mobileProjectRemoveResult,
  mobileProjectRenameParams,
  mobileProjectRenameResult,
  type MobileManagedProject,
  type MobileProjectDirEntry,
  type MobileProjectShortcut,
  type Project,
  type RpcRequest,
} from "@pigcode/contracts"
import { mobileParams as params, MobileRequestError } from "./request-error"

export const mobileProjectRequests = new Set<string>(Object.values(mobileProjectMethods))

/** 主目录下明确禁止浏览与添加为项目的敏感路径前缀（POSIX 小写匹配）。 */
const FORBIDDEN_HOME_PREFIXES: readonly string[] = [
  "library/keychains",
  "library/cookies",
  "library/accounts",
  "library/application support/pigcode",
  "library/application support/@pigcode",
  "appdata",
]

function toPosix(value: string): string {
  return value.split(sep).join("/")
}

function isForbiddenRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false
  const lower = relPath.toLowerCase()
  const segments = lower.split("/")
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.startsWith(".")) {
      return true
    }
  }
  return FORBIDDEN_HOME_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`),
  )
}

function safeRealpath(target: string): string | null {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

function formatDisplayPath(homeReal: string, rootPath: string): string {
  const real = safeRealpath(rootPath) ?? rootPath
  if (real === homeReal) return "~"
  if (real.startsWith(homeReal + sep)) {
    return `~/${toPosix(relative(homeReal, real))}`
  }
  return basename(rootPath) || rootPath
}

function directoryHasVisibleChildDir(dirPath: string, relPrefix: string): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (isForbiddenRelPath(childRel)) continue
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

export class MobileProjectManage {
  private readonly homeReal: string

  constructor(
    private readonly ctx: Context,
    private readonly requireDevice: () => void,
    homeDirOverride?: string,
  ) {
    const rawHome = homeDirOverride ?? homedir()
    this.homeReal = safeRealpath(rawHome) ?? rawHome
  }

  dispatch(request: RpcRequest): unknown {
    this.requireDevice()
    switch (request.method) {
      case mobileProjectMethods.list:
        params(mobileProjectManageListParams, request.params)
        return this.list()
      case mobileProjectMethods.browseDirs: {
        const parsed = params(mobileProjectBrowseDirsParams, request.params)
        return this.browseDirs(parsed.relPath ?? "")
      }
      case mobileProjectMethods.add: {
        const parsed = params(mobileProjectAddParams, request.params)
        return this.add(parsed.relPath, parsed.name)
      }
      case mobileProjectMethods.rename: {
        const parsed = params(mobileProjectRenameParams, request.params)
        return this.rename(parsed.projectId, parsed.name)
      }
      case mobileProjectMethods.remove: {
        const parsed = params(mobileProjectRemoveParams, request.params)
        return this.remove(parsed.projectId)
      }
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private mapProject(project: Project): MobileManagedProject {
    const threadCount = this.ctx.threads
      .list()
      .filter((t) => !t.parentThreadId && t.projectId === project.id && t.archivedAt === null).length
    return {
      id: project.id,
      name: project.name,
      displayPath: formatDisplayPath(this.homeReal, project.rootPath),
      createdAt: project.createdAt,
      threadCount,
    }
  }

  private resolveDirectory(relPath: string): { absReal: string; normalizedRel: string } {
    if (!isValidMobileHomeRelPath(relPath) || isForbiddenRelPath(relPath)) {
      throw new MobileRequestError("PROJECT_PATH_FORBIDDEN")
    }
    const candidate = relPath ? join(this.homeReal, ...relPath.split("/")) : this.homeReal
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      throw new MobileRequestError("PROJECT_NOT_DIRECTORY")
    }
    if (real !== this.homeReal && !real.startsWith(this.homeReal + sep)) {
      throw new MobileRequestError("PROJECT_PATH_FORBIDDEN")
    }
    let stats
    try {
      stats = statSync(real)
    } catch {
      throw new MobileRequestError("PROJECT_NOT_DIRECTORY")
    }
    if (!stats.isDirectory()) {
      throw new MobileRequestError("PROJECT_NOT_DIRECTORY")
    }
    const normalizedRel = real === this.homeReal ? "" : toPosix(relative(this.homeReal, real))
    if (!isValidMobileHomeRelPath(normalizedRel) || isForbiddenRelPath(normalizedRel)) {
      throw new MobileRequestError("PROJECT_PATH_FORBIDDEN")
    }
    return { absReal: real, normalizedRel }
  }

  private buildShortcuts(): MobileProjectShortcut[] {
    const seen = new Set<string>([""])
    const shortcuts: MobileProjectShortcut[] = [
      { label: "主目录", relPath: "", displayPath: "~" },
    ]
    for (const project of this.ctx.projects.list()) {
      if (shortcuts.length >= MOBILE_PROJECT_SHORTCUT_LIMIT) break
      const real = safeRealpath(project.rootPath)
      if (!real || !real.startsWith(this.homeReal + sep)) continue
      const parent = dirname(real)
      if (parent === this.homeReal || !parent.startsWith(this.homeReal + sep)) continue
      const parentRel = toPosix(relative(this.homeReal, parent))
      if (seen.has(parentRel) || !isValidMobileHomeRelPath(parentRel) || isForbiddenRelPath(parentRel)) {
        continue
      }
      seen.add(parentRel)
      shortcuts.push({
        label: basename(parent) || parentRel,
        relPath: parentRel,
        displayPath: `~/${parentRel}`,
      })
    }
    return shortcuts
  }

  private list() {
    const projects = this.ctx.projects.list().map((project) => this.mapProject(project))
    return mobileProjectManageListResult.parse({ projects })
  }

  private browseDirs(relPath: string) {
    const { absReal, normalizedRel } = this.resolveDirectory(relPath)

    const addedByReal = new Map<string, string>()
    for (const project of this.ctx.projects.list()) {
      const real = safeRealpath(project.rootPath) ?? project.rootPath
      addedByReal.set(real, project.id)
    }

    let rawEntries
    try {
      rawEntries = readdirSync(absReal, { withFileTypes: true })
    } catch {
      throw new MobileRequestError("PROJECT_PATH_FORBIDDEN")
    }

    const candidates: MobileProjectDirEntry[] = []
    for (const entry of rawEntries) {
      if (entry.name.startsWith(".")) continue
      const childRel = normalizedRel ? `${normalizedRel}/${entry.name}` : entry.name
      if (!isValidMobileHomeRelPath(childRel) || isForbiddenRelPath(childRel)) continue

      const childPath = join(absReal, entry.name)
      const childReal = safeRealpath(childPath)
      if (!childReal) continue
      if (childReal !== this.homeReal && !childReal.startsWith(this.homeReal + sep)) continue
      const realRel = toPosix(relative(this.homeReal, childReal))
      if (!isValidMobileHomeRelPath(realRel) || isForbiddenRelPath(realRel)) continue

      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(childReal).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (!isDir) continue

      candidates.push({
        name: entry.name,
        relPath: childRel,
        isGitRepo: existsSync(join(childReal, ".git")),
        alreadyAddedProjectId: addedByReal.get(childReal) ?? null,
        hasChildren: directoryHasVisibleChildDir(childReal, childRel),
      })
    }

    candidates.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    const truncated = candidates.length > MOBILE_PROJECT_BROWSE_LIMIT
    const entries = truncated ? candidates.slice(0, MOBILE_PROJECT_BROWSE_LIMIT) : candidates

    const parentRelPath =
      normalizedRel === ""
        ? null
        : normalizedRel.includes("/")
          ? normalizedRel.slice(0, normalizedRel.lastIndexOf("/"))
          : ""

    return mobileProjectBrowseDirsResult.parse({
      currentRelPath: normalizedRel,
      displayPath: normalizedRel ? `~/${normalizedRel}` : "~",
      parentRelPath,
      shortcuts: this.buildShortcuts(),
      entries,
      truncated,
    })
  }

  private add(relPath: string, name?: string) {
    const { absReal, normalizedRel } = this.resolveDirectory(relPath)
    if (!normalizedRel) {
      throw new MobileRequestError("PROJECT_PATH_FORBIDDEN")
    }
    const project = this.ctx.projects.add(absReal, name)
    return mobileProjectAddResult.parse({ project: this.mapProject(project) })
  }

  private rename(projectId: string, name: string) {
    const project = this.ctx.projects.rename(projectId, name)
    if (!project) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return mobileProjectRenameResult.parse({ project: this.mapProject(project) })
  }

  private remove(projectId: string) {
    const project = this.ctx.projects.remove(projectId)
    if (!project) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    for (const run of this.ctx.agents.listRuns()) {
      if (this.ctx.threads.get(run.threadId)?.projectId === projectId) {
        this.ctx.agents.cancelRun(run.runId)
      }
    }
    this.ctx.get("terminal")?.closeProject(projectId)
    return mobileProjectRemoveResult.parse({ removed: true, projectId })
  }
}

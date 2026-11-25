import { isAbsolute } from "node:path"
import {
  mobileAgentCommandDescriptionLimit,
  mobileAgentCommandShortLimit,
  mobileAgentCommandTextLimit,
  mobileAgentCommandsParams,
  mobileAgentCommandsResult,
  mobileMentionFrameBytes,
  mobileMentionMethods as methods,
  mobileMentionPathLimit,
  mobileSearchPathsDefaultLimit,
  mobileSearchPathsParams,
  mobileSearchPathsResult,
  type AgentCommand,
  type MobileAgentCommand,
  type MobileAgentCommandKind,
  type MobileAgentCommandSource,
  type MobileAgentCommandsParams,
  type MobileAgentCommandsResult,
  type MobilePathEntry,
  type MobileSearchPathsParams,
  type MobileSearchPathsResult,
  type Project,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { PathSearchResult } from "../services/path-search"
import { threadCwd } from "../services/worktrees"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

const searchResultBaseBytes = Buffer.byteLength('{"entries":[],"truncated":true}')
const commandResultBaseBytes = Buffer.byteLength('{"commands":[],"truncated":true}')
const pluginSkillPathPattern = /[/\\](?:\.codex|\.agents|\.claude)[/\\]plugins[/\\]/
const windowsDrivePattern = /^[a-zA-Z]:/

export const mobileMentionRequests: ReadonlySet<string> = new Set(Object.values(methods))

function clipText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= maxLength) return trimmed
  const prefix = trimmed.slice(0, maxLength - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

/** 校验并规范化为相对 POSIX 路径；拒绝空路径、绝对路径、盘符、NUL 字节与 `..` 穿越段。 */
export function sanitizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) return null
  if (raw.startsWith("/") || raw.startsWith("\\") || windowsDrivePattern.test(raw) || isAbsolute(raw)) {
    return null
  }
  const normalizedSeparators = raw.replaceAll("\\", "/")
  const rawSegments = normalizedSeparators.split("/")
  const cleanSegments: string[] = []
  for (const segment of rawSegments) {
    if (segment === "..") return null
    if (segment === "" || segment === ".") continue
    cleanSegments.push(segment)
  }
  if (cleanSegments.length === 0) return null
  const normalized = cleanSegments.join("/")
  if (
    normalized.length > mobileMentionPathLimit ||
    normalized.startsWith("/") ||
    windowsDrivePattern.test(normalized)
  ) {
    return null
  }
  return normalized
}

function resolveCommandSource(
  command: AgentCommand,
  kind: MobileAgentCommandKind,
): MobileAgentCommandSource | undefined {
  if (kind === "command" && command.kind === "builtin") return "builtin"
  if (command.pluginId || pluginSkillPathPattern.test(command.path ?? "")) return "plugin"
  if (["repo", "project", "workspace", "local"].includes(command.scope ?? "")) return "project"
  if (["user", "personal"].includes(command.scope ?? "")) return "user"
  if (command.scope === "system") return "system"
  return kind === "command" ? "custom" : undefined
}

/** 把 Host 的 AgentCommand 投影为手机端条目，显式区分 `/` 命令与 `$` Skill 且不泄露本地绝对路径。 */
export function projectMobileAgentCommand(command: AgentCommand): MobileAgentCommand | null {
  const name = command.name.trim()
  const text = command.text.trim()
  if (!name || !text) return null
  if (name.length > mobileAgentCommandTextLimit || text.length > mobileAgentCommandTextLimit) {
    return null
  }
  const kind: MobileAgentCommandKind | null = text.startsWith("$")
    ? "skill"
    : text.startsWith("/")
      ? "command"
      : null
  if (!kind) return null

  const displayName = clipText(command.displayName, mobileAgentCommandShortLimit)
  const description = clipText(command.description, mobileAgentCommandDescriptionLimit)
  const shortDescription = clipText(command.shortDescription, mobileAgentCommandShortLimit)
  const argumentHint = clipText(command.argumentHint, mobileAgentCommandShortLimit)
  const source = resolveCommandSource(command, kind)

  return {
    name,
    text,
    kind,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(shortDescription ? { shortDescription } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(source ? { source } : {}),
  }
}

function isMissingFilesystemTarget(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

export class MobileMentionCommands {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
    private readonly frameByteBudget = mobileMentionFrameBytes,
  ) {}

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.searchPaths:
        return this.searchPaths(mobileParams(mobileSearchPathsParams, request.params))
      case methods.agentCommands:
        return this.agentCommands(mobileParams(mobileAgentCommandsParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private requireProject(projectId: string): Project {
    const project = this.ctx.projects.list().find(({ id }) => id === projectId)
    if (!project) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    return project
  }

  private requireActiveInstance(instanceId: string) {
    const instance = this.ctx.agents.findInstance(instanceId)
    if (
      !instance ||
      !instance.enabled ||
      !this.ctx.agents.list().some(({ id }) => id === instance.agentId)
    ) {
      throw new MobileRequestError("DRAFT_SELECTION_UNAVAILABLE")
    }
    return instance
  }

  private async searchPaths({
    threadId,
    projectId,
    query,
    limit = mobileSearchPathsDefaultLimit,
    refresh,
  }: MobileSearchPathsParams): Promise<MobileSearchPathsResult> {
    const scope =
      threadId !== undefined
        ? (requireMobileThread(this.ctx, threadId), threadId)
        : (this.requireProject(projectId!), { projectId: projectId! })

    const workspace = this.ctx.get("workspace")
    if (!workspace) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")

    let raw: PathSearchResult
    try {
      raw = await workspace.searchPaths(scope, query.trim(), limit, refresh)
    } catch (error) {
      if (isMissingFilesystemTarget(error)) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
      throw error
    }

    this.requirePairedDevice()
    if (threadId !== undefined) requireMobileThread(this.ctx, threadId)
    else this.requireProject(projectId!)

    const entries: MobilePathEntry[] = []
    const seen = new Set<string>()
    let truncated = raw.truncated
    let usedBytes = searchResultBaseBytes

    for (const candidate of raw.entries) {
      const path = sanitizeRelativePath(candidate.path)
      if (!path) continue
      const kind = candidate.kind === "directory" ? "dir" : "file"
      const dedupKey = `${kind}\0${path}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      if (entries.length >= limit) {
        truncated = true
        break
      }
      const entry: MobilePathEntry = { path, kind }
      const itemBytes = Buffer.byteLength(JSON.stringify(entry)) + (entries.length > 0 ? 1 : 0)
      if (usedBytes + itemBytes > this.frameByteBudget) {
        truncated = true
        break
      }
      usedBytes += itemBytes
      entries.push(entry)
    }

    return mobileSearchPathsResult.parse({ entries, truncated })
  }

  private async agentCommands({
    instanceId,
    threadId,
    projectId,
    refresh,
  }: MobileAgentCommandsParams): Promise<MobileAgentCommandsResult> {
    const instance = this.requireActiveInstance(instanceId)
    let cwd: string | null = null
    if (threadId !== undefined) {
      requireMobileThread(this.ctx, threadId)
      cwd = this.ctx.get("workspace")?.root(threadId) ?? threadCwd(this.ctx, threadId)
    } else if (projectId !== undefined) {
      cwd = this.requireProject(projectId).rootPath
    }

    const raw = await this.ctx.agents.commands(
      instance.agentId,
      instance.instanceId,
      cwd,
      refresh === true,
    )

    this.requirePairedDevice()
    this.requireActiveInstance(instanceId)
    if (threadId !== undefined) requireMobileThread(this.ctx, threadId)
    else if (projectId !== undefined) this.requireProject(projectId)

    const commands: MobileAgentCommand[] = []
    const seen = new Set<string>()
    let truncated = false
    let usedBytes = commandResultBaseBytes

    for (const item of raw) {
      const projected = projectMobileAgentCommand(item)
      if (!projected || seen.has(projected.text)) continue
      seen.add(projected.text)
      const itemBytes = Buffer.byteLength(JSON.stringify(projected)) + (commands.length > 0 ? 1 : 0)
      if (usedBytes + itemBytes > this.frameByteBudget) {
        truncated = true
        break
      }
      usedBytes += itemBytes
      commands.push(projected)
    }

    return mobileAgentCommandsResult.parse({ commands, truncated })
  }
}

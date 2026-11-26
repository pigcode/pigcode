/** 手机端工作台写操作辅助：参数解析、可写路径校验、写入错误映射与会话忙碌检查。 */
import { isAbsolute } from "node:path"
import {
  MOBILE_WORKBENCH_PATH_MAX,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  MOBILE_WORKBENCH_WRITE_MAX_BYTES,
  mobileWorkspaceCreateFileParams,
  mobileWorkspaceWriteFileParams,
  mobileWorkspaceWriteStartParams,
  type MobileWorkspaceCreateFileParams,
  type MobileWorkspaceWriteFileParams,
  type MobileWorkspaceWriteStartParams,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import {
  DirectoryNotEmptyError,
  FileChangedError,
  PathExistsError,
  PathForbiddenError,
} from "../services/workspace"
import { MobileRequestError } from "./request-error"
import { errorCodeOf } from "./workbench-helpers"

const windowsDrivePattern = /^[a-zA-Z]:/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseWriteFileParams(input: unknown): MobileWorkspaceWriteFileParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceWriteFileParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX &&
    mobileWorkspaceWriteFileParams.safeParse({ ...value, text: "" }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

export function parseCreateFileParams(input: unknown): MobileWorkspaceCreateFileParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceCreateFileParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text, "utf8") > MOBILE_WORKBENCH_WRITE_INLINE_MAX &&
    mobileWorkspaceCreateFileParams.safeParse({ ...value, text: "" }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

export function parseWriteStartParams(input: unknown): MobileWorkspaceWriteStartParams {
  const value = input === undefined ? {} : input
  const parsed = mobileWorkspaceWriteStartParams.safeParse(value)
  if (parsed.success) return parsed.data
  if (
    isRecord(value) &&
    typeof value.totalBytes === "number" &&
    Number.isInteger(value.totalBytes) &&
    value.totalBytes > MOBILE_WORKBENCH_WRITE_MAX_BYTES &&
    mobileWorkspaceWriteStartParams.safeParse({ ...value, totalBytes: 1 }).success
  ) {
    throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
  }
  throw new MobileRequestError("INVALID_PARAMS")
}

/** 校验并规范化可写相对路径；提前拒绝绝对路径、NUL、`..`、根目录与 `.git`。 */
export function normalizeWritablePath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    windowsDrivePattern.test(raw) ||
    isAbsolute(raw)
  ) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const segments = raw.replaceAll("\\", "/").split("/")
  const clean: string[] = []
  for (const segment of segments) {
    if (segment === ".." || segment.toLowerCase() === ".git") {
      throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
    }
    if (segment === "" || segment === ".") continue
    clean.push(segment)
  }
  if (clean.length === 0) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const normalized = clean.join("/")
  if (normalized.length > MOBILE_WORKBENCH_PATH_MAX) {
    throw new MobileRequestError("INVALID_PARAMS")
  }
  return normalized
}

/** 把底层工作区写入错误映射为规范的 MobileRequestError，不透传宿主机绝对路径。 */
export function mapWorkspaceWriteError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  if (error instanceof FileChangedError) {
    throw new MobileRequestError("WORKBENCH_FILE_CONFLICT")
  }
  if (error instanceof PathExistsError) {
    throw new MobileRequestError("WORKBENCH_PATH_EXISTS")
  }
  if (error instanceof DirectoryNotEmptyError) {
    throw new MobileRequestError("WORKBENCH_DIR_NOT_EMPTY")
  }
  if (error instanceof PathForbiddenError) {
    throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
  }
  const code = errorCodeOf(error)
  if (code === "EEXIST") throw new MobileRequestError("WORKBENCH_PATH_EXISTS")
  if (code === "ENOTEMPTY") throw new MobileRequestError("WORKBENCH_DIR_NOT_EMPTY")
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOOP"
  ) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
  if (error instanceof Error) {
    const message = error.message
    if (
      message.startsWith("path escapes project:") ||
      message.startsWith("absolute path not allowed:") ||
      message.startsWith("refusing to write git metadata:") ||
      message.startsWith("cannot modify workspace root:") ||
      message.startsWith("cannot move directory into itself:")
    ) {
      throw new MobileRequestError("WORKBENCH_PATH_FORBIDDEN")
    }
    if (message.startsWith("file too large to save:")) {
      throw new MobileRequestError("WORKBENCH_FILE_TOO_LARGE")
    }
    if (message === "path must not be empty" || message.startsWith("not a file:")) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
  }
  throw error
}

/** 会话（及其共享同一 Worktree 的主会话/子代理会话）有活跃 run 时拒绝切换/删除 worktree 或恢复检查点。 */
export function assertThreadNotBusy(ctx: Context, threadId: string): void {
  const agents = ctx.get("agents")
  if (!agents) return
  const threads = ctx.get("threads")
  const current = threads?.get(threadId)
  const rootThreadId = current?.parentThreadId ?? threadId
  const busyThreads = new Set<string>([
    threadId,
    rootThreadId,
    ...(threads?.children(rootThreadId).map((child) => child.id) ?? []),
  ])
  if (agents.listRuns().some((run) => busyThreads.has(run.threadId))) {
    throw new MobileRequestError("THREAD_BUSY")
  }
}

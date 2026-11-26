/** 工作台相关的 RPC 命令分发：文件树/编辑、Git、PR、检查点与工作树。 */
import type { Context } from "cordis"
import type { CommandMethod, CommandParams } from "@pigcode/contracts"
import type { WorkspaceScope } from "../services/worktrees"

export const WORKBENCH_COMMANDS = new Set<CommandMethod>([
  "workspace.tree",
  "project.files",
  "workspace.root",
  "workspace.list",
  "workspace.searchPaths",
  "workspace.readFile",
  "workspace.writeFile",
  "workspace.createFile",
  "workspace.renamePath",
  "workspace.deletePath",
  "workspace.search",
  "git.status",
  "git.branches",
  "git.switchBranch",
  "git.createBranch",
  "git.diff",
  "pr.status",
  "pr.create",
  "pr.comment",
  "pr.merge",
  "pr.ready",
  "pr.close",
  "pr.reopen",
  "checkpoint.list",
  "checkpoint.create",
  "checkpoint.restore",
  "worktree.list",
  "worktree.create",
  "worktree.switch",
  "worktree.remove",
])

/**
 * 右侧面板与终端的 threadId / projectId 转成服务用的 WorkspaceScope：会话 id，或者草稿的项目。
 * 契约保证两个只给了一个。
 */
export function scopeOf(value: {
  threadId?: string | undefined
  projectId?: string | undefined
}): WorkspaceScope {
  const scope: WorkspaceScope = value.threadId ?? { projectId: value.projectId ?? "" }
  return scope
}

export async function dispatchWorkbenchCommand(
  ctx: Context,
  command: CommandMethod,
  parsed: unknown,
): Promise<unknown> {
  switch (command) {
    case "workspace.tree":
      return ctx.workspace.tree(scopeOf(parsed as CommandParams<"workspace.tree">))
    case "project.files":
      return ctx.workspace.projectTree((parsed as { projectId: string }).projectId)
    case "workspace.root":
      return {
        root: ctx.workspace.root(scopeOf(parsed as CommandParams<"workspace.root">)),
      }
    case "workspace.list": {
      const value = parsed as CommandParams<"workspace.list">
      return ctx.workspace.list(scopeOf(value), value.path)
    }
    case "workspace.searchPaths": {
      const value = parsed as CommandParams<"workspace.searchPaths">
      return ctx.workspace.searchPaths(scopeOf(value), value.query, value.limit, value.refresh)
    }
    case "workspace.readFile": {
      const value = parsed as CommandParams<"workspace.readFile">
      return ctx.workspace.readFile(scopeOf(value), value.path, value.encoding)
    }
    case "workspace.writeFile": {
      const value = parsed as CommandParams<"workspace.writeFile">
      return ctx.workspace.writeFile(scopeOf(value), value.path, value.text, {
        expectedMtimeMs: value.expectedMtimeMs,
        eol: value.eol,
      })
    }
    case "workspace.createFile": {
      const value = parsed as CommandParams<"workspace.createFile">
      return ctx.workspace.createFile(scopeOf(value), value.path, value.text)
    }
    case "workspace.renamePath": {
      const value = parsed as CommandParams<"workspace.renamePath">
      return ctx.workspace.renamePath(scopeOf(value), value.oldPath, value.newPath)
    }
    case "workspace.deletePath": {
      const value = parsed as CommandParams<"workspace.deletePath">
      return ctx.workspace.deletePath(scopeOf(value), value.path, {
        recursive: value.recursive,
      })
    }
    case "workspace.search": {
      const value = parsed as CommandParams<"workspace.search">
      return ctx.workspace.search(scopeOf(value), value.query, value.glob)
    }
    case "git.status":
      return ctx.git.status(scopeOf(parsed as CommandParams<"git.status">))
    case "git.branches":
      return ctx.git.branches((parsed as CommandParams<"git.branches">).projectId)
    case "git.switchBranch":
    case "git.createBranch": {
      const value = parsed as CommandParams<"git.switchBranch">
      return ctx.git.switchBranch(value.projectId, value.branch, command === "git.createBranch")
    }
    case "git.diff": {
      const value = parsed as CommandParams<"git.diff">
      return ctx.git.diff(scopeOf(value), value.base, value.head)
    }
    case "pr.status":
      return ctx.github.status(scopeOf(parsed as CommandParams<"pr.status">))
    case "pr.create": {
      const value = parsed as CommandParams<"pr.create">
      return ctx.github.create(scopeOf(value), {
        title: value.title,
        ...(value.body === undefined ? {} : { body: value.body }),
        ...(value.base === undefined ? {} : { base: value.base }),
        ...(value.draft === undefined ? {} : { draft: value.draft }),
      })
    }
    case "pr.comment": {
      const value = parsed as CommandParams<"pr.comment">
      await ctx.github.comment(scopeOf(value), value.body)
      return { ok: true }
    }
    case "pr.merge": {
      const value = parsed as CommandParams<"pr.merge">
      return ctx.github.merge(scopeOf(value), {
        method: value.method,
        ...(value.deleteBranch === undefined ? {} : { deleteBranch: value.deleteBranch }),
      })
    }
    case "pr.ready":
      return ctx.github.ready(scopeOf(parsed as CommandParams<"pr.ready">))
    case "pr.close":
      return ctx.github.close(scopeOf(parsed as CommandParams<"pr.close">))
    case "pr.reopen":
      return ctx.github.reopen(scopeOf(parsed as CommandParams<"pr.reopen">))
    case "checkpoint.list":
      return ctx.checkpoints.list((parsed as { threadId: string }).threadId)
    case "checkpoint.create": {
      const value = parsed as { threadId: string; label?: string }
      return ctx.checkpoints.create(value.threadId, value.label)
    }
    case "checkpoint.restore": {
      const value = parsed as { threadId: string; checkpointId: string }
      return ctx.checkpoints.restore(value.threadId, value.checkpointId)
    }
    case "worktree.list":
      return ctx.worktrees.list((parsed as { threadId: string }).threadId)
    case "worktree.create":
      return ctx.worktrees.create((parsed as { threadId: string }).threadId)
    case "worktree.switch": {
      const value = parsed as { threadId: string; path: string }
      return ctx.worktrees.switch(value.threadId, value.path)
    }
    case "worktree.remove":
      return ctx.worktrees.remove((parsed as { threadId: string }).threadId)
    default:
      throw new Error(`unsupported method: ${command}`)
  }
}

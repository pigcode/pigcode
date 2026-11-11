/**
 * 右侧面板与终端看的是哪个目录（参照 ZCode，这些都不必依附会话）：会话里是会话的工作目录
 * （可能是 worktree）；新会话草稿里还没有会话，是草稿项目的根目录。展开进 RPC 参数里用：
 * `{ ...scope, path }`。
 */
export type WorkspaceScope = { threadId: string } | { projectId: string }

/** 会话里返回会话 id，草稿里返回 null。 */
export function scopeThreadId(scope: WorkspaceScope): string | null {
  return "threadId" in scope ? scope.threadId : null
}

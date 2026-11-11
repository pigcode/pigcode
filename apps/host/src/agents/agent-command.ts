/**
 * 用户这条消息是不是以 Agent 命令开头：Claude 的 `/名字`、Codex skill 的 `$名字`。
 * CLI 只在命令位于开头时才展开它，所以这一轮的交接不能拼在前面（#75）。
 * 第一个词里还有第二个 `/` 的是路径（`/usr/lib/foo`），不是命令。
 */
export function startsWithAgentCommand(text: string): boolean {
  const first = text.trimStart().split(/\s/, 1)[0] ?? ""
  return /^\/[^/\s]+$/.test(first) || /^\$[\w.:-]+$/.test(first)
}

/**
 * 读写文件的工具行（参照 ZCode 3.18 的 read / edit）：读取只有一行摘要「已读取 文件名」，文件名是
 * 正文色、不带父目录，悬停看完整路径，点文件名在文件面板中打开；写入、编辑与删除显示改动行数，
 * 展开后是内联 diff，多个文件时逐个列出。
 */
import { memo } from "react"
import { Pencil, Search } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { fileChanges, type FileChange } from "../file-changes"
import { outputText, readPath } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { FileChip, FileChips, headLines, toolStatusWord } from "./common"
import { InlineDiff } from "./inline-diff"

/** 读取文件：一行摘要，不能展开。 */
export const ReadRow = memo(function ReadRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const path = readPath(tool)
  return (
    <ToolRow
      id={tool.id}
      icon={Search}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.read.reading") : t("chat.toolCall.read.read")}
      running={running}
      primary={path ? <FileChip path={path} /> : null}
      status={toolStatusWord(t, tool, headLines(outputText(tool)))}
      dataStatus={tool.status}
    />
  )
})

function editKind(
  t: ReturnType<typeof useLocale>["t"],
  operation: FileChange["operation"],
  running: boolean,
): string {
  if (operation === "write") {
    return running ? t("chat.toolCall.edit.writing") : t("chat.toolCall.edit.wrote")
  }
  if (operation === "delete") {
    return running ? t("chat.toolCall.edit.deleting") : t("chat.toolCall.edit.deleted")
  }
  return running ? t("chat.toolCall.edit.editing") : t("chat.toolCall.edit.edited")
}

/** 一个文件的改动行，用在多文件编辑的展开列表里。 */
function FileChangeRow({ id, change }: { id: string; change: FileChange }) {
  const { t } = useLocale()
  return (
    <ToolRow
      id={`${id}:${change.path}`}
      icon={Pencil}
      showIcon={false}
      kind={editKind(t, change.operation, false)}
      primary={<FileChip path={change.path} />}
      diff={change}
    >
      {change.lines.length > 0
        ? () => <InlineDiff lines={change.lines} path={change.path} />
        : undefined}
    </ToolRow>
  )
}

/** 写入、编辑或删除文件。 */
export const EditRow = memo(function EditRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const changes = fileChanges(tool)
  const single = changes.length === 1 ? changes[0] : undefined
  const total = changes.reduce(
    (sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }),
    { added: 0, removed: 0 },
  )
  const operation = single?.operation ?? "edit"
  const failed = toolStatusWord(t, tool, headLines(outputText(tool)))
  const body =
    changes.length > 1
      ? () => (
          <div className="tool-children">
            {changes.map((change) => (
              <FileChangeRow key={change.path} id={tool.id} change={change} />
            ))}
          </div>
        )
      : single && single.lines.length > 0
        ? () => <InlineDiff lines={single.lines} path={single.path} />
        : undefined
  return (
    <ToolRow
      id={tool.id}
      icon={Pencil}
      showIcon={showIcon}
      kind={editKind(t, operation, running)}
      running={running}
      primary={
        changes.length > 0 ? <FileChips paths={changes.map((change) => change.path)} /> : null
      }
      expandedPrimary={
        changes.length > 1
          ? t("chat.toolCall.edit.multipleFiles").replace("{count}", String(changes.length))
          : undefined
      }
      diff={running ? null : total}
      hideDiffWhenOpen={changes.length > 1}
      status={failed}
      title={changes.map((change) => change.path).join("\n")}
      dataStatus={tool.status}
    >
      {body}
    </ToolRow>
  )
})

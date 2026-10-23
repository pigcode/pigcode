/**
 * 一轮结束后的改动汇总（参照 ZCode 的 ConversationFileSummaryPanel）：一张卡片，标题行是
 * 「N 个文件已更改 +a -d」，点开逐个列出文件名、相对路径与行数；「审查」在右栏 Diff 里查看，
 * 打开按钮在文件面板里打开文件。
 */
import { memo } from "react"
import { ChevronRight, SquareArrowOutUpRight } from "lucide-react"
import { FileIcon, useLocale } from "@pigcode/ui-primitives"
import type { FileChange } from "./file-changes"
import { splitPath } from "./tool-fields"
import { useToolOpen } from "./tool-open"
import { DiffCount } from "./tool-row"
import { relativePath, useConversationActions, useCount } from "./tools/common"

function FileSummaryRow({ file }: { file: FileChange }) {
  const { t } = useLocale()
  const { root, onOpenFile, onViewDiff } = useConversationActions()
  const relative = relativePath(file.path, root)
  const { name, parent } = splitPath(relative)
  const review = onViewDiff ? () => onViewDiff(file.path) : undefined
  return (
    <li className="file-summary-row" data-operation={file.operation}>
      <div
        className="file-summary-file"
        role={review ? "button" : undefined}
        tabIndex={review ? 0 : undefined}
        title={relative}
        onClick={review}
        onKeyDown={(event) => {
          if (!review || (event.key !== "Enter" && event.key !== " ")) return
          event.preventDefault()
          review()
        }}
      >
        <FileIcon name={name} kind="file" />
        <span className="file-summary-name">{name}</span>
        {parent ? <span className="file-summary-path">{parent}</span> : null}
        <DiffCount added={file.added} removed={file.removed} />
      </div>
      {review ? (
        <button type="button" className="file-summary-review" onClick={review}>
          {t("chat.changeSummary.review")}
        </button>
      ) : null}
      {onOpenFile && file.operation !== "delete" ? (
        <button
          type="button"
          className="file-summary-open"
          aria-label={`${t("chat.tool.openFile")} ${relative}`}
          title={t("chat.tool.openFile")}
          onClick={() => onOpenFile(file.path)}
        >
          <SquareArrowOutUpRight className="ic ic-xs" aria-hidden="true" />
        </button>
      ) : null}
    </li>
  )
}

/** 一轮改过的文件；id 用来记住展开状态。 */
export const FileSummary = memo(function FileSummary({
  id,
  files,
}: {
  id: string
  files: readonly FileChange[]
}) {
  const { t } = useLocale()
  const count = useCount()
  const [open, setOpen] = useToolOpen(`files-${id}`, false)
  if (files.length === 0) return null
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  return (
    <section className="file-summary" data-open={open || undefined}>
      <button
        type="button"
        className="file-summary-head"
        aria-expanded={open}
        aria-label={open ? t("chat.changeSummary.collapse") : t("chat.changeSummary.expand")}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className="ic ic-xs file-summary-chev" aria-hidden="true" />
        <span className="file-summary-title">
          {count("chat.changeSummary.filesChanged", files.length)}
        </span>
        <span className="file-summary-stat">
          <span className="add">+{added}</span> <span className="del">-{removed}</span>
        </span>
      </button>
      {open ? (
        <ul className="file-summary-list">
          {files.map((file) => (
            <FileSummaryRow key={file.path} file={file} />
          ))}
        </ul>
      ) : null}
    </section>
  )
})

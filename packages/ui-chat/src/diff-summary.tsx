/** 文件变更摘要；沿用 pigclaude 的 result / diff 结构与类名。 */
import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 单个文件的 diff 行。 */
export interface DiffFile {
  path: string
  lines: string[]
}

/** 一次文件变更的汇总。 */
export interface FileChangeSummary {
  files: DiffFile[]
  additions: number
  deletions: number
}

/** 根据行首字符给出 diff 行样式。 */
function lineClass(line: string): string {
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-") || line.startsWith("−")) return "del"
  return "hunk"
}

/** 取出行首的增删标记，普通行留空。 */
function lineMark(line: string): string {
  const first = line[0]
  if (first === "+" || first === "-" || first === "−") return first
  return " "
}

/** 渲染文件变更摘要；点击查看展开 diff。 */
export function DiffSummary({
  summary,
  onView,
}: {
  summary: FileChangeSummary
  onView?: ((summary: FileChangeSummary) => void) | undefined
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)

  function toggle(): void {
    onView?.(summary)
    setOpen((value) => !value)
  }

  return (
    <div className={`result${open ? " is-open" : ""}`}>
      <Button
        variant="plain"
        className="result-head"
        type="button"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronRight className="ic ic-sm chev" aria-hidden="true" />
        <span>
          {summary.files.length} {t("chat.diff.filesChanged")}
        </span>
        <span className="num t-ok">+{summary.additions}</span>
        <span className="num t-bad">−{summary.deletions}</span>
        <span className="grow" />
        <span className="muted">{open ? t("chat.hide") : t("chat.view")}</span>
      </Button>
      {open ? (
        <div className="result-body">
          {summary.files.map((file) => (
            <div className="diff-file" key={file.path}>
              <div className="diff-path">{file.path}</div>
              {file.lines.length > 0 ? (
                <div className="diff">
                  {file.lines.map((line, index) => (
                    <div key={`${file.path}-${index}`} className={lineClass(line)}>
                      <span className="ln">{index + 1}</span>
                      <span className="sg">{lineMark(line)}</span>
                      <span>{line.replace(/^[+−-]/, "")}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

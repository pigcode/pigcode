/** Diff 视图：用 diff 的 parsePatch 解析 unified diff，按行渲染增删与上下文。 */
import { useMemo } from "react"
import { parsePatch, type StructuredPatch } from "diff"

/** Diff 视图属性；diff 文本通常来自 git.diff。 */
export interface DiffViewProps {
  diff: string
  emptyText?: string
}

/** 一行 diff 的分类。 */
type DiffLineKind = "add" | "remove" | "context" | "meta"

/** 预计算好的行，避免渲染时反复解析行号。 */
interface RenderedLine {
  kind: DiffLineKind
  text: string
  sign: string
  oldLine: number | null
  newLine: number | null
}

/** 一个 hunk 的渲染数据。 */
interface RenderedHunk {
  key: string
  header: string
  lines: RenderedLine[]
}

/** 一个文件的渲染数据。 */
interface RenderedFile {
  key: string
  oldName: string
  newName: string
  hunks: RenderedHunk[]
}

/** 解析单个 hunk；行号按 unified diff 规则推进。 */
function renderHunk(hunk: StructuredPatch["hunks"][number], index: number): RenderedHunk {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const lines = hunk.lines.map((line): RenderedLine => {
    const prefix = line.charAt(0)
    if (prefix === "+") {
      const rendered: RenderedLine = {
        kind: "add",
        text: line.slice(1),
        sign: "+",
        oldLine: null,
        newLine,
      }
      newLine += 1
      return rendered
    }
    if (prefix === "-") {
      const rendered: RenderedLine = {
        kind: "remove",
        text: line.slice(1),
        sign: "-",
        oldLine,
        newLine: null,
      }
      oldLine += 1
      return rendered
    }
    if (prefix === "\\") {
      return { kind: "meta", text: line, sign: "\\", oldLine: null, newLine: null }
    }
    const rendered: RenderedLine = {
      kind: "context",
      text: line.slice(1),
      sign: " ",
      oldLine,
      newLine,
    }
    oldLine += 1
    newLine += 1
    return rendered
  })
  return {
    key: `${index}:${hunk.oldStart}:${hunk.newStart}`,
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines,
  }
}

/** 解析单个文件 patch。 */
function renderFile(patch: StructuredPatch, index: number): RenderedFile {
  return {
    key: `${index}:${patch.oldFileName ?? "unknown"}:${patch.newFileName ?? "unknown"}`,
    oldName: patch.oldFileName ?? "未知文件",
    newName: patch.newFileName ?? "未知文件",
    hunks: patch.hunks.map((hunk, hunkIndex) => renderHunk(hunk, hunkIndex)),
  }
}

/** 容错解析；格式不合法时展示为空而不是让界面崩溃。 */
function parseDiff(diff: string): RenderedFile[] {
  try {
    return parsePatch(diff).map((patch, index) => renderFile(patch, index))
  } catch {
    return []
  }
}

/** Diff 视图入口。 */
export function DiffView({ diff, emptyText = "暂无变更" }: DiffViewProps) {
  const files = useMemo(() => (diff.trim().length === 0 ? [] : parseDiff(diff)), [diff])

  if (files.length === 0) return <p className="workbench-empty">{emptyText}</p>

  return (
    <div className="diff-view">
      {files.map((file) => (
        <section className="diff-file" key={file.key}>
          <header className="diff-file-header">
            <span>{file.oldName}</span>
            {file.oldName !== file.newName ? (
              <>
                <span aria-hidden="true"> → </span>
                <span>{file.newName}</span>
              </>
            ) : null}
          </header>
          {file.hunks.map((hunk) => (
            <div className="diff-hunk" key={hunk.key}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  className={`diff-line diff-line-${line.kind}`}
                  key={`${hunk.key}:${lineIndex}`}
                >
                  <span className="diff-line-no">{line.oldLine ?? ""}</span>
                  <span className="diff-line-no">{line.newLine ?? ""}</span>
                  <span className="diff-line-sign" aria-hidden="true">
                    {line.sign}
                  </span>
                  <span className="diff-line-text">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

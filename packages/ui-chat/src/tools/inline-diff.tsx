/**
 * 编辑行展开后的内联 diff（参照 ZCode 的轻量 diff 预览）：新增与删除行带浅色底与左侧色条，
 * 知道行号时显示行号栏；代码按文件类型高亮，太长时截断并说明省略了多少行。
 */
import { useEffect, useState } from "react"
import {
  highlightLines,
  languageForPath,
  useLocale,
  type HighlightToken,
} from "@pigcode/ui-primitives"
import type { DiffLine } from "../file-changes"

/** 预览最多显示的行数；再长就截断。 */
const MAX_LINES = 400

function useHighlighted(lines: readonly DiffLine[], path: string): HighlightToken[][] | null {
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null)
  const language = languageForPath(path)
  const code = lines.map((line) => line.text).join("\n")
  useEffect(() => {
    setTokens(null)
    if (!language || code.length > 120_000) return undefined
    let cancelled = false
    void highlightLines(code, language).then((result) => {
      if (!cancelled) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language])
  return tokens
}

/** 渲染一个文件的改动预览。 */
export function InlineDiff({ lines, path }: { lines: readonly DiffLine[]; path: string }) {
  const { t } = useLocale()
  const shown = lines.slice(0, MAX_LINES)
  const omitted = lines.length - shown.length
  const tokens = useHighlighted(shown, path)
  const numbered = shown.some((line) => line.line !== undefined)
  return (
    <div className="inline-diff" data-numbered={numbered || undefined}>
      <div className="inline-diff-body">
        {shown.map((line, index) =>
          line.kind === "gap" ? (
            <div key={index} className="idiff-line is-gap" aria-hidden="true">
              {numbered ? <span className="idiff-gutter" /> : null}
              <span className="idiff-marker" />
              <span className="idiff-code">⋯</span>
            </div>
          ) : (
            <div key={index} className={`idiff-line is-${line.kind}`}>
              {numbered ? <span className="idiff-gutter">{line.line ?? ""}</span> : null}
              <span className="idiff-marker" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
              </span>
              <span className="idiff-code">
                {tokens?.[index]
                  ? tokens[index].map((token, tokenIndex) => (
                      <span key={tokenIndex} className="tok" style={token.style}>
                        {token.content}
                      </span>
                    ))
                  : line.text || " "}
              </span>
            </div>
          ),
        )}
      </div>
      {omitted > 0 ? (
        <p className="inline-diff-note">
          {t("diff.preview.truncated").replace("{count}", String(omitted))}
        </p>
      ) : null}
    </div>
  )
}

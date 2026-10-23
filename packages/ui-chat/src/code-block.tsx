/**
 * 代码块（参照 ZCode 的 CodeBlock）：标题栏左边是语言，右边是自动换行与复制按钮；
 * 代码按语言高亮（Shiki），浅色与深色两套颜色随主题切换。消息里的代码与 MCP 结果共用。
 */
import { useEffect, useState } from "react"
import { Check, Copy, WrapText } from "lucide-react"
import {
  copyText,
  highlightLines,
  languageForFence,
  useLocale,
  type HighlightToken,
} from "@pigcode/ui-primitives"

/** 代码块的属性；streaming 时先不高亮，结束后再高亮。 */
export interface CodeBlockProps {
  code: string
  /** 代码围栏里的语言名；也用作标题栏的文字。 */
  language?: string | undefined
  /** 标题栏文字；缺省用语言名。 */
  label?: string | undefined
  streaming?: boolean | undefined
  /** 内容区限高并可滚动，用于工具结果。 */
  compact?: boolean | undefined
  className?: string | undefined
}

function useTokens(code: string, language: string | null, enabled: boolean) {
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null)
  useEffect(() => {
    setTokens(null)
    if (!enabled || !language || code.length > 120_000) return undefined
    let cancelled = false
    void highlightLines(code, language).then((result) => {
      if (!cancelled) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, language, enabled])
  return tokens
}

/** 渲染一个代码块。 */
export function CodeBlock({
  code,
  language = "",
  label,
  streaming = false,
  compact = false,
  className,
}: CodeBlockProps) {
  const { t } = useLocale()
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const text = code.replace(/\n$/, "")
  const tokens = useTokens(text, languageForFence(language), !streaming)
  const lines = text.split("\n")
  return (
    <div
      className={["code-block", compact ? "is-compact" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      data-wrap={wrap || undefined}
    >
      <div className="code-block-head">
        <span className="code-block-lang">{(label ?? language) || "text"}</span>
        <span className="code-block-actions">
          <button
            type="button"
            className="code-block-btn"
            aria-pressed={wrap}
            aria-label={t("codeBlock.wrapLines")}
            title={t("codeBlock.wrapLines")}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText className="ic ic-xs" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="code-block-btn"
            aria-label={copied ? t("codeBlock.copied") : t("codeBlock.copyCode")}
            title={copied ? t("codeBlock.copied") : t("codeBlock.copyCode")}
            onClick={() => void copyText(text).then(() => setCopied(true))}
          >
            {copied ? (
              <Check className="ic ic-xs" aria-hidden="true" />
            ) : (
              <Copy className="ic ic-xs" aria-hidden="true" />
            )}
          </button>
        </span>
      </div>
      <pre className="code-block-body">
        <code>
          {tokens
            ? tokens.map((line, index) => (
                <span key={index} className="code-block-line">
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} className="tok" style={token.style}>
                      {token.content}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))
            : lines.map((line, index) => (
                <span key={index} className="code-block-line">
                  {line}
                  {"\n"}
                </span>
              ))}
        </code>
      </pre>
    </div>
  )
}

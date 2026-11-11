// 外观页的主题代码面板：平时显示带语法着色的代码（颜色值前面有色点），可以复制；点编辑就地变成输入框，
// 应用成功才回到显示状态，失败时在下面说明原因。格式见 ui-primitives 的 theme-code。
import { useEffect, useId, useState, type ReactNode } from "react"
import { Check, Copy, PencilLine } from "lucide-react"
import {
  Button,
  Textarea,
  applyThemeCode,
  copyText,
  decodeThemeCode,
  encodeThemeCode,
  parseHex,
  themeCodePrefix,
  useLocale,
  type AppearanceController,
  type MessageKey,
} from "@pigcode/ui-primitives"

type Mode = "light" | "dark"

/** 把一行主题代码排成多行：前缀单独一行，JSON 两空格缩进。解析不了时原样返回。 */
function prettyCode(code: string): string {
  if (!code.startsWith(themeCodePrefix)) return code
  try {
    const data: unknown = JSON.parse(code.slice(themeCodePrefix.length))
    return `${themeCodePrefix}${JSON.stringify(data, null, 2)}`
  } catch {
    return code
  }
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?|true|false|null)/g

/**
 * 给排好的代码着色：前缀单独一色，JSON 里键名、字符串、数字和 null 各一种颜色，
 * #RRGGBB 字符串前面加一个该颜色的点。
 */
function highlight(source: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let code = source
  if (code.startsWith(themeCodePrefix)) {
    nodes.push(
      <span key="prefix" className="tok-prefix">
        {themeCodePrefix}
      </span>,
    )
    code = code.slice(themeCodePrefix.length)
  }
  let last = 0
  for (const match of code.matchAll(TOKEN)) {
    const index = match.index
    if (index > last) nodes.push(code.slice(last, index))
    const [whole, text, colon, literal] = match
    if (text !== undefined && colon !== undefined) {
      nodes.push(
        <span key={index} className="tok-key">
          {text}
        </span>,
        colon,
      )
    } else if (text !== undefined) {
      const hex = parseHex(text.slice(1, -1))
      nodes.push(
        <span key={index} className="tok-string">
          {hex ? <i className="tok-swatch" style={{ background: hex }} /> : null}
          {text}
        </span>,
      )
    } else if (literal !== undefined) {
      nodes.push(
        <span key={index} className="tok-literal">
          {literal}
        </span>,
      )
    }
    last = index + whole.length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return nodes
}

/** 主题代码面板。 */
export function ThemeCodePanel({
  appearance,
  mode,
}: {
  appearance: AppearanceController
  mode: Mode
}) {
  const { t } = useLocale()
  const { settings, customThemes, update } = appearance
  const code = encodeThemeCode(settings, customThemes, mode)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState<MessageKey | null>(null)
  const [copied, setCopied] = useState(false)
  const errorId = useId()

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  // 切换浅色、深色时放弃没应用的编辑
  useEffect(() => {
    setEditing(false)
    setError(null)
  }, [mode])

  const startEditing = () => {
    setText(prettyCode(code))
    setError(null)
    setEditing(true)
  }

  const apply = () => {
    const result = decodeThemeCode(text)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    // 浅色代码贴进深色（或反过来）多半是贴错了地方：深底配深字之类的结果很难看出原因
    if (result.code.variant !== null && result.code.variant !== mode) {
      setError(
        result.code.variant === "light"
          ? "settings.appearance.code.lightCode"
          : "settings.appearance.code.darkCode",
      )
      return
    }
    update((current) => applyThemeCode(current, customThemes, mode, result.code))
    setEditing(false)
  }

  const label = t(
    mode === "light" ? "settings.appearance.lightCode" : "settings.appearance.darkCode",
  )

  return (
    <div className="code-panel" data-editing={editing || undefined}>
      <div className="code-panel-head">
        <span className="code-panel-title">{label}</span>
        {editing ? (
          <span className="code-panel-actions">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={apply}>
              {t("settings.appearance.editCode.apply")}
            </Button>
          </span>
        ) : (
          <span className="code-panel-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void copyText(code).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }}
            >
              {copied ? (
                <Check className="ic ic-sm" aria-hidden="true" />
              ) : (
                <Copy className="ic ic-sm" aria-hidden="true" />
              )}
              {copied ? t("settings.appearance.copied") : t("settings.appearance.copyCode")}
            </Button>
            <Button variant="ghost" size="sm" onClick={startEditing}>
              <PencilLine className="ic ic-sm" aria-hidden="true" />
              {t("settings.appearance.editCode")}
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <>
          <Textarea
            className="code-panel-input"
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={text}
            rows={14}
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setText(event.currentTarget.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) apply()
              if (event.key === "Escape") setEditing(false)
            }}
          />
          {error ? (
            <p id={errorId} className="code-panel-error" role="alert">
              {t(error)}
            </p>
          ) : null}
        </>
      ) : (
        <pre className="code-panel-code">
          <code>{highlight(prettyCode(code))}</code>
        </pre>
      )}
    </div>
  )
}

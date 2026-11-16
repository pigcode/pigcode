import { useId, useState } from "react"
import { Button, SegmentedControl, Textarea, copyText, useLocale } from "@pigcode/ui-primitives"

const copy = {
  "zh-CN": {
    input: "原始内容",
    output: "结果",
    copy: "复制结果",
    copied: "已复制",
    running: "处理中…",
  },
  "en-US": {
    input: "Source",
    output: "Result",
    copy: "Copy result",
    copied: "Copied",
    running: "Working…",
  },
}

export function TransformPanel<Mode extends string>({
  modes,
  initialMode,
  modeLabel,
  runLabel,
  transform,
}: {
  modes: readonly { value: Mode; label: string }[]
  initialMode: Mode
  modeLabel: string
  runLabel: string
  transform: (source: string, mode: Mode) => string | Promise<string>
}) {
  const { locale } = useLocale()
  const t = copy[locale]
  const inputId = useId()
  const outputId = useId()
  const [mode, setMode] = useState(initialMode)
  const [source, setSource] = useState("")
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  function clearResult(): void {
    setOutput(null)
    setError("")
    setCopied(false)
  }

  async function run(): Promise<void> {
    clearResult()
    setBusy(true)
    try {
      setOutput(await transform(source, mode))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SegmentedControl
        options={modes}
        value={mode}
        aria-label={modeLabel}
        disabled={busy}
        onValueChange={(value) => {
          setMode(value)
          clearResult()
        }}
      />
      <div className="field">
        <label className="label" htmlFor={inputId}>
          {t.input}
        </label>
        <Textarea
          className="mono"
          id={inputId}
          rows={8}
          value={source}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setSource(event.target.value)
            clearResult()
          }}
        />
      </div>
      <Button
        size="sm"
        variant="primary"
        disabled={busy || !source.trim()}
        onClick={() => void run()}
      >
        {busy ? t.running : runLabel}
      </Button>
      {error ? (
        <pre className="error-text" role="alert">
          {error}
        </pre>
      ) : null}
      {output !== null ? (
        <div className="field">
          <label className="label" htmlFor={outputId}>
            {t.output}
          </label>
          <Textarea
            className="mono"
            id={outputId}
            value={output}
            rows={8}
            readOnly
            spellCheck={false}
          />
          <Button
            size="sm"
            onClick={() => {
              void copyText(output).then(
                () => setCopied(true),
                (reason: unknown) => setError(String(reason)),
              )
            }}
          >
            {copied ? t.copied : t.copy}
          </Button>
        </div>
      ) : null}
    </>
  )
}

import { useId, useMemo, useState } from "react"
import { ListRow, Textarea, useLocale } from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { countText } from "./count.ts"

const copy = {
  "zh-CN": {
    title: "文本统计",
    input: "待统计的文本",
    words: "词数",
    characters: "Unicode 字符",
    lines: "行数",
    bytes: "UTF-8 字节",
  },
  "en-US": {
    title: "Text Stats",
    input: "Text to measure",
    words: "Words",
    characters: "Unicode code points",
    lines: "Lines",
    bytes: "UTF-8 bytes",
  },
}

function TextStats() {
  const { locale } = useLocale()
  const t = copy[locale]
  const inputId = useId()
  const [text, setText] = useState("")
  const stats = useMemo(() => countText(text), [text])
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={inputId}>
          {t.input}
        </label>
        <Textarea
          id={inputId}
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="group" aria-live="polite">
        <ListRow title={t.words} meta={stats.words.toLocaleString(locale)} />
        <ListRow title={t.characters} meta={stats.characters.toLocaleString(locale)} />
        <ListRow title={t.lines} meta={stats.lines.toLocaleString(locale)} />
        <ListRow title={t.bytes} meta={stats.bytes.toLocaleString(locale)} />
      </div>
    </>
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  return ctx.surfaces.register({
    id: "pigcode.text-stats",
    title: copy[ctx.locale.get() === "zh-CN" ? "zh-CN" : "en-US"].title,
    Component: TextStats,
  })
}

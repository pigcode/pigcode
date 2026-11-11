/**
 * 输入框的排法（参照 Cursor 的输入框）：平时是一行，正文一行写不下时正文挪到上面，按钮留在下面一排，各自的左右位置不变。
 * 写回一行也不收起，清空了才收回，免得在两种排法之间来回跳。
 */
import { useEffect, useState } from "react"
import type { Editor } from "@tiptap/react"

/** 正文是不是已经写到了第二行；enabled 为 false（总是展开的输入框）时不测量。 */
export function useWrapped(editor: Editor | null, enabled: boolean): boolean {
  const [wrapped, setWrapped] = useState(false)
  useEffect(() => {
    if (!editor || !enabled) return undefined
    const dom = editor.view.dom
    const measure = (): void => {
      if (editor.isDestroyed) return
      if (editor.isEmpty) {
        setWrapped(false)
        return
      }
      const style = window.getComputedStyle(dom)
      const line = Number.parseFloat(style.lineHeight)
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      if (line > 0 && dom.scrollHeight - padding > line * 1.5) setWrapped(true)
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(dom)
    editor.on("update", measure)
    measure()
    return () => {
      observer?.disconnect()
      editor.off("update", measure)
    }
  }, [editor, enabled])
  return wrapped
}

/** 输入框卡片的类名：草稿里更高，写到第二行时展开，有上下文占用时多一列圆环。 */
export function composerClass(options: {
  tall: boolean
  expanded: boolean
  meter: boolean
}): string {
  return [
    "composer",
    options.tall ? "is-tall" : "",
    options.expanded ? "is-expanded" : "is-compact",
    options.meter ? "has-meter" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

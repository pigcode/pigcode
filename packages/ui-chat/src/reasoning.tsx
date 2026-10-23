/**
 * 思考（参照 ZCode 的 Reasoning）：大脑图标与「正在思考」（扫光，后面滚动显示最新一句）或
 * 「思考 · 持续了 N 秒」，默认收起。展开后是纯文本的思考内容：最多 240px 高、左侧一条细线，
 * 流式输出时跟随到底部，用户往上翻时停下。
 */
import { memo, useLayoutEffect, useRef, useState } from "react"
import { Brain } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { ToolRow } from "./tool-row"

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return (lines.at(-1) ?? "").trim()
}

function ReasoningBody({ text, streaming }: { text: string; streaming: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  useLayoutEffect(() => {
    const element = box.current
    if (element && streaming && following) element.scrollTop = element.scrollHeight
  }, [text, streaming, following])
  return (
    <div
      ref={box}
      className="reasoning-body"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= 8)
      }}
    >
      {text.trim()}
    </div>
  )
}

/** 一段思考；streaming 表示还在输出，durationMs 为 null 时显示「持续了几秒」。 */
export const ReasoningBlock = memo(function ReasoningBlock({
  id,
  text,
  durationMs,
  streaming = false,
}: {
  id: string
  text: string
  durationMs: number | null
  streaming?: boolean | undefined
}) {
  const { t } = useLocale()
  if (!text.trim()) return null
  const duration =
    durationMs === null
      ? t("chat.reasoning.durationFewSeconds")
      : t("chat.reasoning.durationSeconds").replace(
          "{seconds}",
          String(Math.max(1, Math.ceil(durationMs / 1000))),
        )
  const peek = streaming ? lastLine(text) : ""
  return (
    <ToolRow
      id={id}
      icon={Brain}
      kind={streaming ? t("chat.reasoning.thinking") : t("chat.reasoning.thought")}
      running={streaming}
      separator={!streaming || Boolean(peek)}
      primary={
        streaming ? (
          peek ? (
            <span className="reasoning-peek">
              <span>{peek}</span>
            </span>
          ) : null
        ) : (
          duration
        )
      }
      expandedPrimary={streaming ? null : undefined}
      className="reasoning-row"
      dataStatus={streaming ? "running" : "completed"}
    >
      {() => <ReasoningBody text={text} streaming={streaming} />}
    </ToolRow>
  )
})

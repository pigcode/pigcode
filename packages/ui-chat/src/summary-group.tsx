/**
 * 连续摘要组的一行（参照 ZCode 3.18 的 ConsecutiveSummaryGroup）：默认收起。组还没闭合（在这一轮的
 * 末尾、这一轮还在跑）时，收起的组头就是当前那一项的摘要，动作一直扫光；闭合后换成统计「已查阅 5 项，
 * 已执行 6 命令，已修改 3 文件」，只有修改时在统计后面列出文件。展开后组头总是统计，下面的子项沿一条
 * 左侧导线排开、不带图标，最多 16 行高，再多就在组里滚动，跟着新的一项到底部。
 */
import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react"
import { Brain, ChevronRight } from "lucide-react"
import { useLocale, type MessageKey } from "@pigcode/ui-primitives"
import {
  activeSummaryItem,
  summaryCounts,
  summaryIconItem,
  type SummaryCounts,
} from "./summary-groups"
import { SummaryIconContext, SummaryPreviewContext } from "./tool-row"
import { FileChip, useConversationActions } from "./tools/common"
import type { WorkItem } from "./turns"

/** 收起时最多列出几个改过的文件，其余写成 +N。 */
const SHOWN_FILES = 3

type Translate = (key: MessageKey) => string

/** 「查阅 5 项，执行 6 命令，修改 3 文件」；闭合后每段前面加「已」，只有思考时是「思考」。 */
export function summaryStatistics(t: Translate, counts: SummaryCounts, closed: boolean): string {
  const tense = closed ? "completed." : ""
  const parts = (
    [
      ["explore", counts.explore],
      ["run", counts.run],
      ["change", counts.files.length],
      ["unresolved", counts.unresolved],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([category, count]) =>
      t(
        `chat.summaryGroup.${category}.${tense}${count === 1 ? "one" : "other"}` as MessageKey,
      ).replace("{count}", String(count)),
    )
  return parts.length > 0
    ? parts.join(t("chat.summaryGroup.separator"))
    : t("chat.summaryGroup.reasoning")
}

/** 只改了文件的组：收起时统计后面跟着文件名；只改了一个文件时直接写「已修改 文件名」。 */
function ChangedFiles({ label, files }: { label: string; files: readonly string[] }) {
  const shown = files.slice(0, SHOWN_FILES)
  return (
    <span className="summary-group-files">
      <span className="summary-group-label">{label}</span>
      {shown.map((path) => (
        <FileChip key={path} path={path} />
      ))}
      {files.length > shown.length ? (
        <span className="summary-group-more">+{files.length - shown.length}</span>
      ) : null}
    </span>
  )
}

/** 展开后的列表跟着新的一项到底部；往上翻时停下，翻回底部再跟。 */
function useFollowBottom(content: unknown) {
  const box = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [edges, setEdges] = useState<"none" | "top" | "bottom" | "both">("none")
  const measure = (element: HTMLDivElement) => {
    const top = element.scrollTop > 0
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight > 1
    setEdges(top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none")
  }
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    if (following.current) element.scrollTop = element.scrollHeight
    measure(element)
  }, [content])
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2
    measure(element)
  }
  return { box, edges, onScroll }
}

/** 一组连续的摘要。tail 表示它在这一轮的末尾、这一轮还在跑，后面还能接新的工作。 */
export const SummaryGroup = memo(function SummaryGroup({
  items,
  tail,
  renderItem,
  renderPreview,
}: {
  items: readonly WorkItem[]
  tail: boolean
  /** 展开后列表里的一项，不带图标。 */
  renderItem: (item: WorkItem) => ReactNode
  /** 组头里预览的一项，或者代表图标取自的那一项；只用内置的工具行。 */
  renderPreview: (item: WorkItem) => ReactNode
}) {
  const { t } = useLocale()
  const { root } = useConversationActions()
  const [open, setOpen] = useState(false)
  const scroll = useFollowBottom(open ? items : null)
  const counts = summaryCounts(items, root)
  const statistics = summaryStatistics(t, counts, !tail)
  const active = activeSummaryItem(items)
  const current = active ?? items.at(-1)!
  const iconItem = summaryIconItem(items)
  const changeOnly =
    counts.explore === 0 && counts.run === 0 && counts.files.length > 0 && counts.unresolved === 0
  const collapsed =
    !open && changeOnly ? (
      <ChangedFiles
        label={
          counts.files.length === 1
            ? t(
                tail
                  ? "chat.summaryGroup.change.label"
                  : "chat.summaryGroup.change.completed.label",
              )
            : statistics
        }
        files={counts.files}
      />
    ) : (
      statistics
    )
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    setOpen(!open)
  }
  return (
    <div className="summary-group" data-open={open || undefined} data-running={tail || undefined}>
      <div
        className="summary-group-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={statistics}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        {open || !tail ? (
          <>
            <span className="summary-group-icon" aria-hidden="true">
              {iconItem ? (
                <SummaryIconContext.Provider value>
                  {renderPreview(iconItem)}
                </SummaryIconContext.Provider>
              ) : (
                <Brain className="ic tool-row-icon" />
              )}
            </span>
            <span
              className={
                tail && !active ? "summary-group-stats tool-shimmer" : "summary-group-stats"
              }
              title={statistics}
            >
              {open ? statistics : collapsed}
            </span>
          </>
        ) : (
          // 预览只是摘要：里面的文件名、按钮都不能点，点哪里都是展开这一组。
          <div key={current.key} className="summary-group-preview" inert>
            <SummaryPreviewContext.Provider value>
              {renderPreview(current)}
            </SummaryPreviewContext.Provider>
          </div>
        )}
        <ChevronRight className="ic ic-sm summary-group-chev" aria-hidden="true" />
      </div>
      {open ? (
        <div
          ref={scroll.box}
          className="summary-group-body"
          data-edges={scroll.edges}
          onScroll={scroll.onScroll}
        >
          <div className="summary-group-list">{items.map((item) => renderItem(item))}</div>
        </div>
      ) : null}
    </div>
  )
})

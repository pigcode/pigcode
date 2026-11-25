/**
 * 连续摘要组的一行（参照 ZCode 3.18 的 ConsecutiveSummaryGroup）：默认收起。组还没闭合（在这一轮的
 * 末尾、这一轮还在跑）时，收起的组头就是当前那一项的摘要，动作一直扫光；闭合后换成统计「已查阅 5 项，
 * 已执行 6 命令，已修改 3 文件」，只有修改时在统计后面列出文件。展开后组头总是统计，下面的子项沿一条
 * 左侧导线排开、不带图标，最多 16 行高，再多就在组里滚动，跟着新的一项到底部。
 */
import {
  memo,
  useLayoutEffect,
  useMemo,
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
import { splitPath } from "./tool-fields"
import { SummaryIconContext, SummaryPreviewContext } from "./tool-row"
import { FileChip, useConversationActions } from "./tools/common"
import type { WorkItem } from "./turns"

/** 组头展开箭头的预留宽度（8px 间距 + 12px 箭头 + 余量，参照 ZCode 4.0.0 的 epn）。 */
const CHEVRON_RESERVE = 24
/** 读不到计算样式时的默认间距，与 `.summary-group-files` 的 `gap: 8px` 一致。 */
const DEFAULT_FILES_GAP = 8

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

/** 按给定可用宽度计算最多可放下的文件 chip 数：全放得下不显示 `+N`，否则在预留 `+N` 宽度内放尽量多。 */
export function fitFileCount(
  availableWidth: number,
  labelWidth: number,
  chipWidths: readonly number[],
  moreWidthForHidden: (hidden: number) => number,
  gap: number,
): number {
  const total = chipWidths.length
  if (total <= 1) return total

  let allWidth = labelWidth
  for (let index = 0; index < total; index += 1) {
    allWidth += gap + chipWidths[index]!
  }
  if (allWidth <= availableWidth) return total

  let used = labelWidth
  let shown = 0
  for (let index = 0; index < total - 1; index += 1) {
    const nextUsed = used + gap + chipWidths[index]!
    const hidden = total - (index + 1)
    if (nextUsed + gap + moreWidthForHidden(hidden) > availableWidth) break
    used = nextUsed
    shown = index + 1
  }
  return shown
}

function measureWidth(element: HTMLElement): number {
  const rectWidth = element.getBoundingClientRect().width
  return rectWidth > 0 ? rectWidth : element.offsetWidth
}

/** 计算 `.summary-group-files` 的可用宽度；容器本身宽度为 0（如未布局的 jsdom）时返回 null。 */
function availableFilesWidth(group: HTMLElement, filesEl: HTMLElement): number | null {
  const groupRect = group.getBoundingClientRect()
  const filesRect = filesEl.getBoundingClientRect()
  if (groupRect.width > 0) {
    return Math.max(0, groupRect.right - filesRect.left - CHEVRON_RESERVE)
  }
  const groupWidth = group.offsetWidth || group.clientWidth
  if (groupWidth <= 0) return null
  const offset = filesRect.left > groupRect.left ? filesRect.left - groupRect.left : 0
  return Math.max(0, groupWidth - offset - CHEVRON_RESERVE)
}

/** 借用不可见的临时测量容器测出标签、全部文件 chip 与 `+N` 的实际宽度，算出能放下的数量。 */
function measureShownCount(
  group: HTMLElement,
  filesEl: HTMLElement,
  label: string,
  files: readonly string[],
): number {
  if (files.length <= 1) return files.length
  const available = availableFilesWidth(group, filesEl)
  if (available === null) return files.length

  const style = window.getComputedStyle(filesEl)
  const parsedGap = Number.parseFloat(style.columnGap || style.gap)
  const gap = Number.isFinite(parsedGap) ? parsedGap : DEFAULT_FILES_GAP

  const probe = document.createElement("span")
  probe.className = "summary-group-measure"
  probe.setAttribute("aria-hidden", "true")

  const labelEl = document.createElement("span")
  labelEl.className = "summary-group-label"
  labelEl.textContent = label
  probe.append(labelEl)

  const chipEls = files.map((path) => {
    const chip = document.createElement("span")
    chip.className = "file-chip"
    const icon = document.createElement("span")
    icon.className = "file-icon"
    const name = document.createElement("span")
    name.className = "truncate"
    name.textContent = splitPath(path).name
    chip.append(icon, name)
    probe.append(chip)
    return chip
  })

  const maxDigits = String(files.length).length
  const moreByDigits = new Map<number, HTMLSpanElement>()
  for (let digits = 1; digits <= maxDigits; digits += 1) {
    const more = document.createElement("span")
    more.className = "summary-group-more"
    more.textContent = digits === maxDigits ? `+${files.length}` : `+${"9".repeat(digits)}`
    probe.append(more)
    moreByDigits.set(digits, more)
  }

  group.append(probe)
  try {
    const labelWidth = measureWidth(labelEl)
    const chipWidths = chipEls.map(measureWidth)
    if (chipWidths.every((width) => width <= 0)) return files.length
    const moreWidths = new Map<number, number>()
    for (const [digits, element] of moreByDigits) moreWidths.set(digits, measureWidth(element))
    return fitFileCount(
      available,
      labelWidth,
      chipWidths,
      (hidden) => moreWidths.get(String(hidden).length) ?? moreWidths.get(maxDigits) ?? 0,
      gap,
    )
  } finally {
    probe.remove()
  }
}

/** 只改了文件的组：收起时按容器可用宽度动态列出文件名与 +N；只改了一个文件时直接写「已修改 文件名」。 */
function ChangedFiles({ label, files }: { label: string; files: readonly string[] }) {
  const filesRef = useRef<HTMLSpanElement>(null)
  const filesKey = files.join("\0")
  const paths = useMemo(() => (filesKey ? filesKey.split("\0") : []), [filesKey])
  const [shownCount, setShownCount] = useState(paths.length)

  useLayoutEffect(() => {
    if (paths.length <= 1) {
      setShownCount(paths.length)
      return
    }
    const filesEl = filesRef.current
    const group = filesEl?.closest<HTMLElement>(".summary-group")
    if (!filesEl || !group) {
      setShownCount(paths.length)
      return
    }
    const update = () => {
      const next = measureShownCount(group, filesEl, label, paths)
      setShownCount((current) => (current === next ? current : next))
    }
    update()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(update)
    observer.observe(group)
    return () => observer.disconnect()
  }, [label, paths])

  const shown = paths.slice(0, Math.min(shownCount, paths.length))
  const hidden = paths.length - shown.length
  return (
    <span ref={filesRef} className="summary-group-files">
      <span className="summary-group-label">{label}</span>
      {shown.map((path) => (
        <FileChip key={path} path={path} />
      ))}
      {shown.length > 0 && hidden > 0 ? (
        <span className="summary-group-more">+{hidden}</span>
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

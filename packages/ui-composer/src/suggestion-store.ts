/**
 * 输入框的 @ 文件与 / 命令建议：TipTap suggestion 插件把状态写进这里，
 * React 面板订阅它渲染列表；键盘上下选择、回车/Tab 确认、Esc 关闭。
 */
import type { SuggestionProps } from "@tiptap/suggestion"

/** 建议列表里的一项。 */
export interface SuggestionItem {
  id: string
  label: string
  detail?: string | undefined
  kind: "file" | "command"
}

/** 面板渲染所需的快照。 */
export interface SuggestionSnapshot {
  active: boolean
  kind: SuggestionItem["kind"] | null
  query: string
  items: readonly SuggestionItem[]
  index: number
  loading: boolean
}

const INACTIVE: SuggestionSnapshot = {
  active: false,
  kind: null,
  query: "",
  items: [],
  index: 0,
  loading: false,
}

/** 外部可订阅的建议状态。 */
export class SuggestionStore {
  private snapshot: SuggestionSnapshot = INACTIVE
  private select: ((item: SuggestionItem) => void) | null = null
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): SuggestionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 插件开始或更新一次建议；查询变化时回到第一项。 */
  show(kind: SuggestionItem["kind"], props: SuggestionProps<SuggestionItem, SuggestionItem>): void {
    this.select = props.command
    const sameQuery = this.snapshot.active && this.snapshot.query === props.query
    const index = sameQuery ? Math.min(this.snapshot.index, Math.max(0, props.items.length - 1)) : 0
    this.set({
      active: true,
      kind,
      query: props.query,
      items: props.items,
      index,
      loading: props.loading,
    })
  }

  /** 插件退出建议。 */
  hide(): void {
    this.select = null
    if (this.snapshot.active) this.set(INACTIVE)
  }

  /** 高亮上一项或下一项，首尾循环。 */
  move(delta: number): void {
    const count = this.snapshot.items.length
    if (count === 0) return
    this.set({ ...this.snapshot, index: (this.snapshot.index + delta + count) % count })
  }

  /** 高亮指定项（鼠标悬停）。 */
  highlight(index: number): void {
    if (index !== this.snapshot.index) this.set({ ...this.snapshot, index })
  }

  /** 确认一项；不传时确认当前高亮项。返回是否有可确认的项。 */
  choose(index = this.snapshot.index): boolean {
    const item = this.snapshot.items[index]
    if (!item || !this.select) return false
    this.select(item)
    return true
  }

  /** 处理建议打开期间的按键；返回 true 表示已消费。 */
  handleKey(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean {
    if (!this.snapshot.active || event.isComposing) return false
    switch (event.key) {
      case "ArrowDown":
        this.move(1)
        return true
      case "ArrowUp":
        this.move(-1)
        return true
      case "Enter":
      case "Tab":
        return this.choose()
      case "Escape":
        this.hide()
        return true
      default:
        return false
    }
  }

  private set(next: SuggestionSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

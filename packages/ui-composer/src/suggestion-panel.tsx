/** @ 文件与 / 命令的建议面板：贴在输入框上沿，宽度与输入框一致。 */
import { useEffect, useRef, useSyncExternalStore } from "react"
import { FileText, Loader2, Slash } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import type { SuggestionStore } from "./suggestion-store"

/** 把路径拆成文件名和所在目录，列表里文件名在前、目录淡显。 */
function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/")
  return slash < 0
    ? { name: path, dir: "" }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/** 渲染建议列表；没有建议时不占位。 */
export function SuggestionPanel({ store }: { store: SuggestionStore }) {
  const { t } = useLocale()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const listRef = useRef<HTMLDivElement>(null)

  // 键盘移动高亮时让当前项保持在可见范围内。
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']")
    active?.scrollIntoView?.({ block: "nearest" })
  }, [snapshot.index, snapshot.items])

  if (!snapshot.active) return null
  const title =
    snapshot.kind === "file" ? t("composer.suggest.files") : t("composer.suggest.commands")
  return (
    <div className="suggest-panel" role="listbox" aria-label={title} ref={listRef}>
      <div className="suggest-title">
        <span>{title}</span>
        {snapshot.loading ? <Loader2 className="ic ic-sm spin" aria-hidden="true" /> : null}
      </div>
      {snapshot.items.length === 0 && !snapshot.loading ? (
        <div className="suggest-empty">
          {snapshot.kind === "file"
            ? t("composer.suggest.noFiles")
            : t("composer.suggest.noCommands")}
        </div>
      ) : null}
      {snapshot.items.map((item, index) => {
        const active = index === snapshot.index
        const path = item.kind === "file" ? splitPath(item.label) : null
        return (
          <div
            key={`${item.kind}-${item.id}`}
            role="option"
            aria-selected={active}
            data-active={active ? "true" : undefined}
            className={active ? "suggest-item is-active" : "suggest-item"}
            onMouseEnter={() => store.highlight(index)}
            onMouseDown={(event) => {
              // 保持编辑器焦点，选择由 suggestion 插件完成。
              event.preventDefault()
              store.choose(index)
            }}
          >
            {item.kind === "file" ? (
              <FileText className="ic ic-sm" aria-hidden="true" />
            ) : (
              <Slash className="ic ic-sm" aria-hidden="true" />
            )}
            <span className="suggest-label">{path ? path.name : item.label}</span>
            <span className="suggest-detail truncate">{path ? path.dir : (item.detail ?? "")}</span>
          </div>
        )
      })}
    </div>
  )
}

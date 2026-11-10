/** 模型选择器列表里的一行。 */
import { Check, Star, Zap } from "lucide-react"
import { ListRow, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import type { ComposerAgent, ComposerModel } from "./composer-options"

/** 列表里的一行：模型与它所属的实例。 */
export interface ModelPickerRow {
  agent: ComposerAgent
  model: ComposerModel
}

/** 模型列表的一行：名字（支持快速模式的带一个闪电）、实例与说明、勾、快捷键与收藏星标。 */
export function ModelRow({
  row,
  rowIndex,
  current,
  highlighted,
  locked,
  favorite,
  onToggleFavorite,
  onHover,
  onChoose,
}: {
  row: ModelPickerRow
  rowIndex: number
  current: boolean
  highlighted: boolean
  locked: boolean
  favorite: boolean
  onToggleFavorite: () => void
  onHover: () => void
  onChoose: () => void
}) {
  const { t } = useLocale()
  // 第二行是模型所属的实例与补充说明，和 T3 一样在每个模型下面标出提供它的实例。
  const note = row.model.isDefault
    ? t("composer.model.default")
    : row.model.custom
      ? t("composer.model.custom")
      : row.model.description
  const favoriteLabel = favorite ? t("composer.model.unfavorite") : t("composer.model.favorite")
  return (
    <ListRow
      role="option"
      aria-selected={current}
      aria-disabled={locked || undefined}
      data-highlighted={highlighted ? "" : undefined}
      className={current ? "model-row is-current" : "model-row"}
      onMouseEnter={onHover}
      onClick={onChoose}
      title={
        <>
          <span className="truncate">{row.model.label}</span>
          {row.model.fast ? (
            <span className="model-row-fast" title={t("composer.speed.supported")}>
              <Zap className="ic" aria-hidden="true" />
            </span>
          ) : null}
        </>
      }
      titleProps={{ className: "model-row-name" }}
      description={
        <span className="model-row-agent">
          <span className="truncate">{row.agent.label}</span>
          {note ? <span className="model-row-note truncate">· {note}</span> : null}
        </span>
      }
      meta={
        current || rowIndex < 9 ? (
          <>
            {current ? <Check className="ic ic-sm model-row-check" aria-hidden="true" /> : null}
            {rowIndex < 9 ? (
              <kbd className="model-row-kbd">{formatShortcut(`Mod+${rowIndex + 1}`)}</kbd>
            ) : null}
          </>
        ) : null
      }
      actions={
        <button
          type="button"
          className="model-star"
          aria-pressed={favorite}
          aria-label={favoriteLabel}
          title={favoriteLabel}
          onClick={(event) => {
            event.stopPropagation()
            onToggleFavorite()
          }}
        >
          <Star className="ic ic-sm" aria-hidden="true" />
        </button>
      }
    />
  )
}

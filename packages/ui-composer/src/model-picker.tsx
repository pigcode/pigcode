/**
 * 模型选择器：左边一列 agent（以及收藏），右边是选中 agent 的模型列表与搜索，
 * 底部是当前模型的思考深度：「默认」加上它支持的档位。只有选中某个 agent 才会列出它自己的模型。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Check, ChevronDown, Loader2, Star } from "lucide-react"
import {
  EmptyState,
  EntityAvatar,
  ListRow,
  Popover,
  SearchField,
  SegmentedControl,
  formatShortcut,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  effortKeys,
  resolveEffort,
  resolveModel,
  type ComposerAgent,
  type ComposerModel,
  type ComposerModelCatalog,
  type ReasoningEffort,
} from "./composer-options"
import { fuzzyScore } from "./fuzzy"
import { modelKey, useModelPreferences } from "./model-preferences"

/** 收藏页在左栏里的 id；不会与 agent id 冲突。 */
const FAVORITES = "__favorites__"

/** 「默认」在分段控件里的值：不发档位，由 agent 自己决定；不会与协议里的档位重名。 */
const DEFAULT_EFFORT = "default"
type EffortChoice = ReasoningEffort | typeof DEFAULT_EFFORT

/** 模型选择器的属性；目录由调用方按 agent 懒加载。 */
export interface ModelPickerProps {
  agents: readonly ComposerAgent[]
  agentId: string | null
  modelId: string | null
  catalog: ComposerModelCatalog
  onLoadModels?: ((agentId: string) => void) | undefined
  onSelectModel?: ((agentId: string, modelId: string) => void) | undefined
  /** 运行中不能切换 agent 或模型；思考深度仍可调整，下一次发送生效。 */
  locked?: boolean
  side?: "top" | "bottom"
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 列表里的一行：模型与它所属的 agent。 */
interface Row {
  agent: ComposerAgent
  model: ComposerModel
}

/** 当前 agent、模型与思考深度的胶囊，以及展开后的选择面板。 */
export function ModelPicker({
  agents,
  agentId,
  modelId,
  catalog,
  onLoadModels,
  onSelectModel,
  locked = false,
  side = "top",
  open,
  onOpenChange,
}: ModelPickerProps) {
  const { t } = useLocale()
  const preferences = useModelPreferences()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const currentModel = resolveModel(agentId ? catalog[agentId] : undefined, modelId)
  const currentKey = agent && currentModel ? modelKey(agent.id, currentModel.id) : null
  const effort = resolveEffort(currentModel, currentKey ? preferences.efforts[currentKey] : null)
  const [tab, setTab] = useState<string>(agentId ?? FAVORITES)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 鼠标悬停换的高亮不滚动列表：滚动会把别的行挪到指针下面。 */
  const hovered = useRef(false)

  // 打开时回到当前 agent、清空搜索；当前 agent 的目录顺便读一次，胶囊才能显示模型名。
  useEffect(() => {
    if (open) {
      setTab(agentId ?? FAVORITES)
      setQuery("")
    }
  }, [open, agentId])
  useEffect(() => {
    if (agentId && catalog[agentId] === undefined) onLoadModels?.(agentId)
  }, [agentId, catalog, onLoadModels])
  useEffect(() => {
    if (open && tab !== FAVORITES && catalog[tab] === undefined) onLoadModels?.(tab)
  }, [open, tab, catalog, onLoadModels])

  const rows = useMemo<Row[]>(() => {
    const all: Row[] =
      tab === FAVORITES
        ? preferences.favorites.flatMap((key) => {
            const [favoriteAgent, ...rest] = key.split("/")
            const entry = agents.find((item) => item.id === favoriteAgent)
            const model = catalog[favoriteAgent ?? ""]?.find((item) => item.id === rest.join("/"))
            return entry && model ? [{ agent: entry, model }] : []
          })
        : (catalog[tab] ?? []).flatMap((model) => {
            const entry = agents.find((item) => item.id === tab)
            return entry ? [{ agent: entry, model }] : []
          })
    if (!query) return all
    return all
      .map((row) => ({
        row,
        score: Math.max(fuzzyScore(row.model.label, query), fuzzyScore(row.model.id, query)),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.row)
  }, [tab, query, catalog, agents, preferences.favorites])

  // 收藏页需要各 agent 的目录才能显示名字。
  useEffect(() => {
    if (!open || tab !== FAVORITES) return
    for (const key of preferences.favorites) {
      const favoriteAgent = key.split("/")[0]
      if (favoriteAgent && catalog[favoriteAgent] === undefined) onLoadModels?.(favoriteAgent)
    }
  }, [open, tab, preferences.favorites, catalog, onLoadModels])

  useEffect(() => {
    setIndex(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }, [tab, query])
  useEffect(() => {
    if (hovered.current) {
      hovered.current = false
      return
    }
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>("[data-highlighted]")
    if (list && row) revealInList(list, row)
  }, [index])

  function choose(row: Row | undefined): void {
    if (!row || locked) return
    onSelectModel?.(row.agent.id, row.model.id)
    onOpenChange(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // 回车总是选中高亮的模型；单选按钮会拦下回车，所以在 defaultPrevented 之前处理。
    if (event.key === "Enter") {
      event.preventDefault()
      choose(rows[index])
      return
    }
    // 思考深度的分段控件自己处理方向键，不再移动列表或切换左栏。
    if (event.defaultPrevented) return
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault()
      choose(rows[Number(event.key) - 1])
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      setIndex((value) => (rows.length ? (value + delta + rows.length) % rows.length : 0))
      return
    }
    // 搜索框为空时用左右方向键切换左栏。
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !query) {
      event.preventDefault()
      const tabs = [FAVORITES, ...agents.map((item) => item.id)]
      const at = tabs.indexOf(tab)
      const delta = event.key === "ArrowRight" ? 1 : -1
      setTab(tabs[(at + delta + tabs.length) % tabs.length] ?? FAVORITES)
    }
  }

  const loading = tab !== FAVORITES && catalog[tab] === undefined
  const tabAgent = agents.find((item) => item.id === tab)
  const chipLabel = currentModel?.label ?? agent?.label ?? t("composer.model.choose")
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Popover.Trigger
        className="chip-btn model-chip"
        type="button"
        title={`${t("composer.modelMenu")} ${formatShortcut("Mod+/")}`}
        aria-label={`${t("composer.modelMenu")}: ${[agent?.label, currentModel?.label, effort ? t(effortKeys[effort]) : null].filter(Boolean).join(" · ")}`}
      >
        {agent ? <EntityAvatar id={agent.id} name={agent.label} size="sm" /> : null}
        <span className="model-name truncate">{chipLabel}</span>
        {effort ? <span className="model-depth">{t(effortKeys[effort])}</span> : null}
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="end" sideOffset={8}>
          <Popover.Popup className="model-picker" initialFocus={searchRef}>
            <div className="model-picker-body" onKeyDown={onKeyDown}>
              <nav
                className="model-rail"
                role="tablist"
                aria-orientation="vertical"
                aria-label={t("composer.model.agents")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === FAVORITES}
                  className="rail-btn"
                  title={t("composer.model.favorites")}
                  aria-label={t("composer.model.favorites")}
                  onClick={() => setTab(FAVORITES)}
                >
                  <Star className="ic" aria-hidden="true" />
                </button>
                <span className="rail-sep" aria-hidden="true" />
                {agents.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === item.id}
                    className="rail-btn"
                    data-current={item.id === agentId ? "true" : undefined}
                    data-unavailable={item.installed === false ? "true" : undefined}
                    title={
                      item.installed === false
                        ? `${item.label} · ${t("composer.model.notInstalled")}`
                        : item.label
                    }
                    aria-label={item.label}
                    onClick={() => setTab(item.id)}
                  >
                    <EntityAvatar id={item.id} name={item.label} size="md" />
                  </button>
                ))}
              </nav>
              <div className="model-pane">
                <div className="model-search">
                  <SearchField
                    variant="plain"
                    inputRef={searchRef}
                    value={query}
                    onValueChange={setQuery}
                    placeholder={t("composer.model.search")}
                  />
                </div>
                <div
                  className="model-list"
                  role="listbox"
                  ref={listRef}
                  aria-label={
                    tab === FAVORITES ? t("composer.model.favorites") : (tabAgent?.label ?? "")
                  }
                >
                  {loading ? (
                    <EmptyState
                      size="compact"
                      icon={<Loader2 className="ic spin" />}
                      title={t("composer.model.loading")}
                    />
                  ) : null}
                  {!loading && rows.length === 0 ? (
                    <EmptyState
                      size="compact"
                      icon={tab === FAVORITES && !query ? <Star className="ic" /> : undefined}
                      title={
                        tab === FAVORITES && !query
                          ? t("composer.model.noFavorites")
                          : t("composer.model.none")
                      }
                    />
                  ) : null}
                  {rows.map((row, rowIndex) => {
                    const key = modelKey(row.agent.id, row.model.id)
                    const current = row.agent.id === agentId && row.model.id === currentModel?.id
                    const favorite = preferences.favorites.includes(key)
                    const subtitle = [
                      row.agent.label,
                      row.model.isDefault
                        ? t("composer.model.default")
                        : row.model.custom
                          ? t("composer.model.custom")
                          : row.model.description,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                    return (
                      <ListRow
                        key={key}
                        role="option"
                        aria-selected={current}
                        aria-disabled={locked || undefined}
                        data-highlighted={rowIndex === index ? "" : undefined}
                        className={current ? "model-row is-current" : "model-row"}
                        onMouseEnter={() => {
                          if (rowIndex === index) return
                          hovered.current = true
                          setIndex(rowIndex)
                        }}
                        onClick={() => choose(row)}
                        title={row.model.label}
                        titleProps={{ className: "model-row-name" }}
                        description={<span className="truncate">{subtitle}</span>}
                        meta={
                          current || rowIndex < 9 ? (
                            <>
                              {current ? (
                                <Check className="ic ic-sm model-row-check" aria-hidden="true" />
                              ) : null}
                              {rowIndex < 9 ? (
                                <kbd className="model-row-kbd">
                                  {formatShortcut(`Mod+${rowIndex + 1}`)}
                                </kbd>
                              ) : null}
                            </>
                          ) : null
                        }
                        actions={
                          <button
                            type="button"
                            className="model-star"
                            aria-pressed={favorite}
                            aria-label={
                              favorite
                                ? t("composer.model.unfavorite")
                                : t("composer.model.favorite")
                            }
                            title={
                              favorite
                                ? t("composer.model.unfavorite")
                                : t("composer.model.favorite")
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              preferences.toggleFavorite(key)
                            }}
                          >
                            <Star className="ic ic-sm" aria-hidden="true" />
                          </button>
                        }
                      />
                    )
                  })}
                </div>
                {locked ? <div className="model-locked">{t("composer.model.locked")}</div> : null}
                {currentModel && currentKey && currentModel.efforts.length > 0 ? (
                  <EffortControl
                    efforts={currentModel.efforts}
                    value={effort}
                    modelLabel={currentModel.label}
                    onChange={(next) => preferences.setEffort(currentKey, next)}
                  />
                ) : null}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * 把行滚进列表的可见范围。只滚列表自己：scrollIntoView 还会滚动外框和页面这些 overflow: hidden 的祖先，
 * 滚走的内容用户拉不回来。
 */
function revealInList(list: HTMLElement, row: HTMLElement): void {
  const view = list.getBoundingClientRect()
  const box = row.getBoundingClientRect()
  if (box.top < view.top) list.scrollTop -= view.top - box.top
  else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom
}

/** 思考深度的分段选择：第一段是「默认」（没选过档位时就是它），后面只列出当前模型支持的档位。 */
function EffortControl({
  efforts,
  value,
  modelLabel,
  onChange,
}: {
  efforts: readonly ReasoningEffort[]
  value: ReasoningEffort | null
  modelLabel: string
  onChange: (effort: ReasoningEffort | null) => void
}) {
  const { t } = useLocale()
  return (
    <div className="model-effort">
      <span className="model-effort-label">
        {t("composer.effort.label")}
        <span className="model-effort-model truncate">{modelLabel}</span>
      </span>
      <SegmentedControl<EffortChoice>
        aria-label={t("composer.effort.label")}
        value={value ?? DEFAULT_EFFORT}
        onValueChange={(next) => onChange(next === DEFAULT_EFFORT ? null : next)}
        options={[
          { value: DEFAULT_EFFORT, label: t("composer.effort.default") },
          ...efforts.map((effort) => ({ value: effort, label: t(effortKeys[effort]) })),
        ]}
      />
    </div>
  )
}

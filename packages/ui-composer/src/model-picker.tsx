/**
 * 模型选择器：左栏是 Agent 实例（以及收藏），右栏是选中实例的模型列表与搜索；底栏从左到右是快速模式与
 * Ultracode 两个开关、当前模型的思考深度滑块与权限。只有选中某个实例才会列出它自己的模型。
 * 思考深度和两个开关按模型记在本机偏好里；权限记在线程上，开启完全访问的确认框由调用方给出。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, Loader2, Star } from "lucide-react"
import {
  AgentIcon,
  EmptyState,
  Popover,
  SearchField,
  formatShortcut,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  effortLabel,
  permissionKeys,
  resolveEffort,
  resolveSwitch,
  resolveModel,
  type ComposerAgent,
  type ComposerModelCatalog,
  type ComposerModelChoice,
  type ModelSwitch,
  type PermissionMode,
} from "./composer-options"
import { fuzzyScore } from "./fuzzy"
import { EffortControl } from "./model-effort"
import { modelKey, useModelPreferences } from "./model-preferences"
import { SwitchButton, SwitchMark, switchLabel } from "./model-switch"
import { ModelRow, type ModelPickerRow } from "./model-row"
import { PERMISSION_ICONS } from "./permission-menu"
import { PermissionSwitch } from "./permission-switch"

/** 底栏里的开关，按这个顺序排；胶囊上的小图标与读屏文字也按它。 */
const MODEL_SWITCHES: readonly ModelSwitch[] = ["fast", "ultracode"]

/** 收藏页在左栏里的 id；不会与 agent id 冲突。 */
const FAVORITES = "__favorites__"

/** 默认的权限：胶囊上不为它画图标。 */
const DEFAULT_PERMISSION: PermissionMode = "workspace-write"

/** 模型选择器的属性；目录由调用方按实例懒加载。 */
export interface ModelPickerProps {
  /** 可选的 Agent 实例；默认实例的 id 就是 agent id。 */
  agents: readonly ComposerAgent[]
  /** 当前选中的实例 id。 */
  agentId: string | null
  modelId: string | null
  catalog: ComposerModelCatalog
  onLoadModels?: ((instanceId: string) => void) | undefined
  onSelectModel?: ((choice: ComposerModelChoice) => void) | undefined
  /** 当前线程的权限；底栏切换，胶囊上在非默认时显示图标。 */
  permissionMode?: PermissionMode
  /** 底栏里可选的权限。 */
  permissionModes?: readonly PermissionMode[]
  /** 选了一个权限；完全访问由调用方先确认。没有时底栏不显示权限。 */
  onPermissionMode?: ((mode: PermissionMode) => void) | undefined
  /** 运行中不能切换实例或模型；思考深度、速度与权限仍可调整，下一次发送生效。 */
  locked?: boolean
  side?: "top" | "bottom"
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Row = ModelPickerRow

/** 当前 agent、模型、思考深度、速度与权限的胶囊，以及展开后的选择面板。 */
export function ModelPicker({
  agents,
  agentId,
  modelId,
  catalog,
  onLoadModels,
  onSelectModel,
  permissionMode = DEFAULT_PERMISSION,
  permissionModes = [],
  onPermissionMode,
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
  const switchOn = (name: ModelSwitch) =>
    resolveSwitch(
      currentModel,
      name,
      currentKey ? preferences.switches[name].includes(currentKey) : false,
    )
  const switches = MODEL_SWITCHES.filter((name) => switchOn(name))
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
    // 设置里隐藏的模型不列出；正在用的那个除外，否则勾选标记没地方显示。
    const listed = (row: Row) =>
      !row.model.hidden || (row.agent.id === agentId && row.model.id === currentModel?.id)
    const all: Row[] = (
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
    ).filter(listed)
    if (!query) return all
    return all
      .map((row) => ({
        row,
        score: Math.max(fuzzyScore(row.model.label, query), fuzzyScore(row.model.id, query)),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.row)
  }, [tab, query, catalog, agents, preferences.favorites, agentId, currentModel?.id])

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

  /**
   * 选中一个模型。弹层不跟着关：选完模型往往还要接着调它的思考深度、快速模式或权限，
   * 底栏会立刻换成新模型的设置；按 Esc 或点外面再关。
   */
  function choose(row: Row | undefined): void {
    if (!row || locked) return
    onSelectModel?.({
      instanceId: row.agent.id,
      agentId: row.agent.agentId,
      modelId: row.model.id,
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement
    // 回车选中高亮的模型；在思考深度滑块上按回车也一样。滑块自己处理方向键。
    const inEffort = target.closest(".model-effort") !== null
    // 底栏的快速开关与权限自己处理按键，回车也是按它们自己的按钮。
    if (!inEffort && target.closest(".model-foot")) return
    if (event.key === "Enter") {
      event.preventDefault()
      choose(rows[index])
      return
    }
    if (event.defaultPrevented || inEffort) return
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
  const PermissionIcon = PERMISSION_ICONS[permissionMode]
  const showPermission = onPermissionMode !== undefined && permissionModes.length > 0
  const chipParts = [
    agent?.label,
    currentModel?.label,
    effort ? effortLabel(effort, t) : null,
    ...switches.map((name) => switchLabel(name, t)),
    permissionMode !== DEFAULT_PERMISSION ? t(permissionKeys[permissionMode].label) : null,
  ]
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Popover.Trigger
        className="chip-btn model-chip"
        type="button"
        data-mode={permissionMode}
        title={`${t("composer.modelMenu")} ${formatShortcut("Mod+/")}`}
        aria-label={`${t("composer.modelMenu")}: ${chipParts.filter(Boolean).join(" · ")}`}
      >
        {agent ? (
          <AgentIcon agentId={agent.agentId} instanceId={agent.id} name={agent.label} />
        ) : null}
        <span className="model-name truncate">{chipLabel}</span>
        {effort ? <span className="model-depth">{effortLabel(effort, t)}</span> : null}
        {switches.map((name) => (
          <SwitchMark key={name} name={name} />
        ))}
        {permissionMode !== DEFAULT_PERMISSION ? (
          <span className="model-chip-mode" data-mode={permissionMode}>
            <PermissionIcon className="ic ic-sm" aria-hidden="true" />
          </span>
        ) : null}
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="end" sideOffset={8}>
          <Popover.Popup className="model-picker" initialFocus={searchRef}>
            <div className="model-picker-frame" onKeyDown={onKeyDown}>
              <div className="model-picker-body">
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
                      <AgentIcon
                        agentId={item.agentId}
                        instanceId={item.id}
                        name={item.label}
                        size="lg"
                      />
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
                    {rows.map((row, rowIndex) => (
                      <ModelRow
                        key={modelKey(row.agent.id, row.model.id)}
                        row={row}
                        rowIndex={rowIndex}
                        current={row.agent.id === agentId && row.model.id === currentModel?.id}
                        highlighted={rowIndex === index}
                        locked={locked}
                        favorite={preferences.favorites.includes(
                          modelKey(row.agent.id, row.model.id),
                        )}
                        onToggleFavorite={() =>
                          preferences.toggleFavorite(modelKey(row.agent.id, row.model.id))
                        }
                        onHover={() => {
                          if (rowIndex === index) return
                          hovered.current = true
                          setIndex(rowIndex)
                        }}
                        onChoose={() => choose(row)}
                      />
                    ))}
                  </div>
                </div>
              </div>
              {locked ? <div className="model-locked">{t("composer.model.locked")}</div> : null}
              <div className="model-foot">
                <div className="model-switches">
                  {MODEL_SWITCHES.map((name) => (
                    <SwitchButton
                      key={name}
                      name={name}
                      on={switchOn(name)}
                      supported={Boolean(currentModel?.[name]) && currentKey !== null}
                      onToggle={() => {
                        if (currentKey) preferences.setSwitch(name, currentKey, !switchOn(name))
                      }}
                    />
                  ))}
                </div>
                <div className="model-foot-center">
                  {currentModel && currentKey ? (
                    <EffortControl
                      efforts={currentModel.efforts}
                      value={effort}
                      modelLabel={currentModel.label}
                      onChange={(next) => preferences.setEffort(currentKey, next)}
                    />
                  ) : null}
                </div>
                {showPermission ? (
                  <PermissionSwitch
                    value={permissionMode}
                    modes={permissionModes}
                    onChange={onPermissionMode}
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

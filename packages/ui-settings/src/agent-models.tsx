/**
 * 实例的模型列表（参照 t3code 设置页的模型列表）：agent 目录里的模型和用户加的自定义模型排成一张表，
 * 每一行可以用开关决定在输入框的模型选择器里显不显示，用上下按钮或拖动排顺序；自定义模型可以移除。
 * 改动都写进设置草稿（hiddenModels、modelOrder、customModels），和其他设置一起保存。
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react"
import { ArrowDown, ArrowUp, GripVertical, Plus, X, Zap } from "lucide-react"
import {
  CUSTOM_MODELS_KEY,
  HIDDEN_MODELS_KEY,
  MODEL_ORDER_KEY,
  type AgentSettingsValues,
} from "@pigcode/contracts"
import { Button, Input, Skeleton, Switch, useLocale } from "@pigcode/ui-primitives"

/** 模型目录里的一个模型：设置页用到名字、id、是否默认与自定义，以及快速模式。 */
export interface AgentModelInfo {
  id: string
  label: string
  isDefault?: boolean | undefined
  custom?: boolean | undefined
  fast?: boolean | undefined
}

/** 列表里的一行。 */
export interface ModelRow {
  id: string
  label: string
  isDefault: boolean
  custom: boolean
  fast: boolean
  hidden: boolean
}

/** 模型偏好的改动：只给要改的键。 */
export type ModelsPatch = Partial<Record<string, string[]>>

/** 设置值里的一个模型 id 列表；不是字符串数组时为空。 */
export function modelList(values: AgentSettingsValues, key: string): string[] {
  const value = values[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

/**
 * 按草稿排出列表：目录里的模型（Host 已按保存的顺序排好）加上草稿里的自定义模型，
 * 再按草稿里的顺序重排；没排过的保持原来的先后。
 */
export function arrangeModels(
  catalog: readonly AgentModelInfo[],
  values: AgentSettingsValues,
): ModelRow[] {
  const custom = modelList(values, CUSTOM_MODELS_KEY)
  const hidden = new Set(modelList(values, HIDDEN_MODELS_KEY))
  const rank = new Map(modelList(values, MODEL_ORDER_KEY).map((id, index) => [id, index]))
  const builtin = catalog.filter((model) => !model.custom)
  const known = new Set(builtin.map((model) => model.id))
  const rows: ModelRow[] = [
    ...builtin.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      isDefault: model.isDefault === true,
      custom: false,
      fast: model.fast === true,
    })),
    ...custom
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: id, isDefault: false, custom: true, fast: false })),
  ].map((row) => ({ ...row, hidden: hidden.has(row.id) }))
  const original = new Map(rows.map((row, index) => [row.id, index]))
  const position = (row: ModelRow) => rank.get(row.id) ?? Number.POSITIVE_INFINITY
  return rows.sort(
    (a, b) => position(a) - position(b) || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0),
  )
}

/** 把 id 从 from 挪到 to 之后的完整顺序。 */
function moved(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

/** 渲染模型列表。catalog 缺省表示目录还在读取；allowCustom 为 false 时不能加自定义模型。 */
export function ModelsEditor({
  catalog,
  values,
  allowCustom,
  onChange,
}: {
  catalog: readonly AgentModelInfo[] | undefined
  values: AgentSettingsValues
  allowCustom: boolean
  onChange: (patch: ModelsPatch) => void
}) {
  const { t } = useLocale()
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const rows = useMemo(() => arrangeModels(catalog ?? [], values), [catalog, values])
  const ids = rows.map((row) => row.id)
  const custom = modelList(values, CUSTOM_MODELS_KEY)
  const hidden = modelList(values, HIDDEN_MODELS_KEY)
  const shown = rows.filter((row) => !row.hidden).length

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= ids.length) return
    onChange({ [MODEL_ORDER_KEY]: moved(ids, from, to) })
  }

  const toggle = (row: ModelRow, visible: boolean) =>
    onChange({
      [HIDDEN_MODELS_KEY]: visible
        ? hidden.filter((id) => id !== row.id)
        : [...hidden.filter((id) => id !== row.id), row.id],
    })

  const remove = (row: ModelRow) =>
    onChange({
      [CUSTOM_MODELS_KEY]: custom.filter((id) => id !== row.id),
      [HIDDEN_MODELS_KEY]: hidden.filter((id) => id !== row.id),
      [MODEL_ORDER_KEY]: modelList(values, MODEL_ORDER_KEY).filter((id) => id !== row.id),
    })

  function add(): void {
    const id = draft.trim()
    if (!id) return
    if (rows.some((row) => row.id === id && !row.custom)) {
      setError(t("agents.models.builtinDuplicate"))
      return
    }
    if (custom.includes(id)) {
      setError(t("agents.models.duplicate"))
      return
    }
    onChange({ [CUSTOM_MODELS_KEY]: [...custom, id] })
    setDraft("")
    setError(null)
    requestAnimationFrame(() => {
      const list = listRef.current
      list?.scrollTo?.({ top: list.scrollHeight, behavior: "smooth" })
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    add()
  }

  /** 拖到某一行上：鼠标在这一行的上半就插到它前面，下半插到它后面。 */
  function onDragOver(event: DragEvent<HTMLLIElement>, index: number): void {
    if (dragging === null) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1)
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    if (dragging !== null && dropAt !== null) {
      const from = ids.indexOf(dragging)
      reorder(from, dropAt > from ? dropAt - 1 : dropAt)
    }
    setDragging(null)
    setDropAt(null)
  }

  return (
    <div className="agent-models">
      <div className="agent-models-head">
        <p className="agent-muted" aria-live="polite">
          {catalog === undefined
            ? t("agents.models.loading")
            : t("agents.models.summary")
                .replace("{count}", String(rows.length))
                .replace("{shown}", String(shown))}
        </p>
        {hidden.length > 0 && rows.some((row) => row.hidden) ? (
          <button
            type="button"
            className="agent-text-btn"
            onClick={() => onChange({ [HIDDEN_MODELS_KEY]: [] })}
          >
            {t("agents.models.showAll")}
          </button>
        ) : null}
      </div>
      {catalog === undefined ? (
        <div className="agent-model-list" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="agent-model-skeleton" />
          ))}
        </div>
      ) : rows.length > 0 ? (
        <ul
          ref={listRef}
          className="agent-model-list"
          aria-label={t("agents.section.models")}
          data-dragging={dragging !== null || undefined}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null)
          }}
        >
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="agent-model"
              data-hidden={row.hidden || undefined}
              data-dragging={dragging === row.id || undefined}
              data-drop={
                dropAt === index
                  ? "before"
                  : dropAt === rows.length && index === rows.length - 1
                    ? "after"
                    : undefined
              }
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", row.id)
                setDragging(row.id)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
              onDragOver={(event) => onDragOver(event, index)}
              onDrop={onDrop}
            >
              <span className="agent-model-grip" aria-hidden="true" title={t("agents.models.drag")}>
                <GripVertical className="ic ic-sm" />
              </span>
              <span className="agent-model-text">
                <span className="agent-model-name truncate">{row.label}</span>
                {row.label !== row.id ? (
                  <code className="agent-model-id truncate">{row.id}</code>
                ) : null}
              </span>
              {row.fast ? (
                <span className="agent-model-cap" title={t("agents.models.fast")}>
                  <Zap className="ic ic-xs" aria-hidden="true" />
                  <span className="sr-only">{t("agents.models.fast")}</span>
                </span>
              ) : null}
              {row.isDefault ? (
                <span className="agent-model-tag" data-kind="default">
                  {t("agents.models.default")}
                </span>
              ) : null}
              {row.custom ? (
                <span className="agent-model-tag">{t("agents.models.custom")}</span>
              ) : null}
              <span className="agent-model-tools">
                <button
                  type="button"
                  className="agent-icon-btn"
                  aria-label={t("agents.models.moveUp").replace("{model}", row.label)}
                  title={t("agents.models.moveUp").replace("{model}", row.label)}
                  disabled={index === 0}
                  onClick={() => reorder(index, index - 1)}
                >
                  <ArrowUp className="ic ic-xs" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="agent-icon-btn"
                  aria-label={t("agents.models.moveDown").replace("{model}", row.label)}
                  title={t("agents.models.moveDown").replace("{model}", row.label)}
                  disabled={index === rows.length - 1}
                  onClick={() => reorder(index, index + 1)}
                >
                  <ArrowDown className="ic ic-xs" aria-hidden="true" />
                </button>
                {row.custom ? (
                  <button
                    type="button"
                    className="agent-icon-btn"
                    data-tone="danger"
                    aria-label={t("agents.models.remove").replace("{model}", row.id)}
                    title={t("agents.models.remove").replace("{model}", row.id)}
                    onClick={() => remove(row)}
                  >
                    <X className="ic ic-xs" aria-hidden="true" />
                  </button>
                ) : null}
              </span>
              <Switch
                className="agent-model-switch"
                aria-label={t("agents.models.show").replace("{model}", row.label)}
                checked={!row.hidden}
                onCheckedChange={(checked) => toggle(row, checked)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {allowCustom ? (
        <div className="agent-input-row">
          <Input
            className="agent-input mono"
            aria-label={t("agents.models.placeholder")}
            placeholder={t("agents.models.placeholder")}
            value={draft}
            maxLength={256}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
            onKeyDown={onKeyDown}
          />
          <Button size="sm" type="button" disabled={!draft.trim()} onClick={add}>
            <Plus className="ic ic-sm" aria-hidden="true" />
            {t("agents.models.add")}
          </Button>
        </div>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  )
}

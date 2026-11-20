import { useState, type SetStateAction } from "react"
import type { AgentInstance, AgentSettingsValues } from "@pigcode/contracts"

interface Edits {
  values: AgentSettingsValues
  label?: string | undefined
  color?: string | null | undefined
}
const empty: Edits = { values: {} }

function instanceKey(instance: Pick<AgentInstance, "instanceId" | "createdAt">): string {
  return JSON.stringify([instance.instanceId, instance.createdAt])
}

/** 计算合并后的草稿值。 */
export function mergeDraftValues(
  base: AgentSettingsValues,
  edits: AgentSettingsValues,
): AgentSettingsValues {
  const values = { ...base }
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) delete values[key]
    else values[key] = value
  }
  return values
}

/** 仅在当前设置页内保留各实例尚未保存的输入，关闭设置页即释放。 */
export function useInstanceEdits(instance?: AgentInstance) {
  const [drafts, setDrafts] = useState(() => new Map<string, Edits>())
  const key = instance ? instanceKey(instance) : ""
  function update(change: (current: Edits) => Edits) {
    setDrafts((current) => {
      const next = new Map(current)
      const draft = change(current.get(key) ?? empty)
      if (
        !Object.keys(draft.values).length &&
        draft.label === undefined &&
        draft.color === undefined
      )
        next.delete(key)
      else next.set(key, draft)
      return next
    })
  }
  return {
    ...(drafts.get(key) ?? empty),
    /** 检查任意实例在当前设置页内是否有未保存改动（用于左侧清单未保存标记）。 */
    isDirty(target: AgentInstance): boolean {
      const draft = drafts.get(instanceKey(target))
      if (!draft) return false
      if (
        draft.label !== undefined &&
        draft.label.trim() !== target.label &&
        draft.label.trim() !== ""
      )
        return true
      const nextColor = draft.color === null ? undefined : (draft.color ?? target.accentColor)
      if (nextColor !== target.accentColor) return true
      return !sameValues(mergeDraftValues(target.values, draft.values), target.values)
    },
    setValues(change: SetStateAction<AgentSettingsValues>) {
      update((current) => ({
        ...current,
        values: typeof change === "function" ? change(current.values) : change,
      }))
    },
    setIdentity(patch: Partial<Pick<Edits, "label" | "color">>) {
      update((current) => ({ ...current, ...patch }))
    },
    clearSavedIdentity() {
      const saved = drafts.get(key) ?? empty
      update((current) => ({
        ...current,
        label: current.label === saved.label ? undefined : current.label,
        color: current.color === saved.color ? undefined : current.color,
      }))
    },
    discard() {
      update(() => empty)
    },
  }
}

export type InstanceEdits = ReturnType<typeof useInstanceEdits>

/** 留空的值：保存时 Host 会去掉，比较时当作没有。 */
function blank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}

/** 两份设置是否相同；对象键顺序与留空的项不影响结果。 */
export function sameValues(left: AgentSettingsValues, right: AgentSettingsValues): boolean {
  const normalize = (values: AgentSettingsValues) =>
    JSON.stringify(
      Object.keys(values)
        .filter((key) => !blank(values[key]))
        .sort()
        .map((key) => [key, values[key]]),
    )
  return normalize(left) === normalize(right)
}

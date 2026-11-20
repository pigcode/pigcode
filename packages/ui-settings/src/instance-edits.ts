import { useState, type SetStateAction } from "react"
import type { AgentInstance, AgentSettingsValues } from "@pigcode/contracts"

interface Edits {
  values: AgentSettingsValues
  label?: string | undefined
  color?: string | null | undefined
}
const empty: Edits = { values: {} }

/** 仅在当前设置页内保留各实例尚未保存的输入，关闭设置页即释放。 */
export function useInstanceEdits(instance?: AgentInstance) {
  const [drafts, setDrafts] = useState(() => new Map<string, Edits>())
  const key = instance ? JSON.stringify([instance.instanceId, instance.createdAt]) : ""
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

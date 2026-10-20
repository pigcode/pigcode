/** 类型化 slot 注册表与 React 宿主；注册返回 disposer。 */
import { Fragment, useSyncExternalStore, type ReactNode } from "react"

/** 当前 UI 暴露的 slot 名称。 */
export type SlotName =
  "sidebar.section" | "chat.view" | "settings.section" | "panel.right" | "status.bar"

/** 单个 slot 条目；id 在同一个 slot 内唯一。 */
export interface SlotEntry<P = unknown> {
  id: string
  order?: number
  /** 用方法签名声明 render，使不同 props 类型的条目可以共存于同一注册表。 */
  render(props: P): ReactNode
}

/** slot 注册、读取与订阅接口。 */
export interface SlotRegistry {
  register<P>(name: SlotName, entry: SlotEntry<P>): () => void
  get(name: SlotName): SlotEntry[]
  subscribe(name: SlotName, listener: () => void): () => void
}

/** 创建 slot registry；每个 slot 内按 order 升序，同 id 后注册的覆盖先注册的。 */
export function createSlotRegistry(): SlotRegistry {
  const slots = new Map<SlotName, SlotEntry[]>()
  const listeners = new Map<SlotName, Set<() => void>>()

  function emit(name: SlotName): void {
    for (const listener of listeners.get(name) ?? []) listener()
  }

  return {
    register(name, entry) {
      const current = slots.get(name) ?? []
      const next = [...current.filter((item) => item.id !== entry.id), entry]
      slots.set(
        name,
        next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      )
      emit(name)
      return () => {
        const existing = slots.get(name) ?? []
        if (!existing.some((item) => item.id === entry.id)) return
        slots.set(
          name,
          existing.filter((item) => item.id !== entry.id),
        )
        emit(name)
      }
    },
    get(name) {
      return slots.get(name) ?? []
    },
    subscribe(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => {
        set.delete(listener)
      }
    },
  }
}

/** 渲染一个 slot 的全部条目；props 会传给每个条目。 */
export function SlotHost<P>({
  registry,
  name,
  props,
}: {
  registry: SlotRegistry
  name: SlotName
  props?: P
}) {
  const entries = useSyncExternalStore(
    (listener) => registry.subscribe(name, listener),
    () => registry.get(name),
    () => registry.get(name),
  )
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.id}>{entry.render(props as P)}</Fragment>
      ))}
    </>
  )
}

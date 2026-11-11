/**
 * 右侧面板与底部终端是否展开（参照 ZCode，每个任务各记各的）。会话之间共用一组开关；每个新会话草稿
 * 各有一组，默认收起，进一个新草稿时不会因为别处开着就摊开一个空面板、起一个 shell。
 * 草稿建成会话时，会话接过草稿的开关：在草稿里打开的面板，发出第一条消息后仍然开着。
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react"
import { flushSync } from "react-dom"
import { onDraftMaterialized } from "./new-thread-draft"

interface PanelOpen {
  right: boolean
  terminal: boolean
}

const CLOSED: PanelOpen = { right: false, terminal: false }

/** 当前位置的两个开关与改它们的方法；draftKey 为 null 表示在会话里（或没有可用的位置）。 */
export function usePanelOpen(draftKey: string | null) {
  const [threadOpen, setThreadOpen] = useState<PanelOpen>(CLOSED)
  const [draftOpen, setDraftOpen] = useState<Record<string, PanelOpen>>({})
  const open = draftKey ? (draftOpen[draftKey] ?? CLOSED) : threadOpen
  const latest = useRef({ draftKey, draftOpen })
  latest.current = { draftKey, draftOpen }

  useEffect(
    () =>
      onDraftMaterialized(() => {
        const { draftKey: key, draftOpen: drafts } = latest.current
        if (!key) return
        // 在当前会话切过去之前同步提交：新会话第一次渲染时开关已经对了，面板不会闪一下。
        flushSync(() => setThreadOpen(drafts[key] ?? CLOSED))
      }),
    [],
  )

  const set = useCallback(
    (panel: keyof PanelOpen, value: SetStateAction<boolean>) => {
      const next = (current: PanelOpen): PanelOpen => ({
        ...current,
        [panel]: typeof value === "function" ? value(current[panel]) : value,
      })
      if (!draftKey) {
        setThreadOpen(next)
        return
      }
      setDraftOpen((all) => ({ ...all, [draftKey]: next(all[draftKey] ?? CLOSED) }))
    },
    [draftKey],
  )

  return {
    rightOpen: open.right,
    terminalOpen: open.terminal,
    setRightOpen: useCallback((value: SetStateAction<boolean>) => set("right", value), [set]),
    setTerminalOpen: useCallback((value: SetStateAction<boolean>) => set("terminal", value), [set]),
  }
}

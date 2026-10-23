/**
 * 还有没保存的文件修改时拦住关闭、退出与刷新窗口：页面阻止卸载，主进程收到
 * will-prevent-unload 后用这里传过去的文案弹确认框，用户选择放弃修改才继续。
 */
import { useEffect } from "react"
import { useLocale } from "@pigcode/ui-primitives"
import { hasDrafts, useDraftVersion } from "./file-drafts"

function preventUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  // Electron 只在 returnValue 不是 undefined 时取消卸载并通知主进程。
  event.returnValue = false
}

/** 挂在 LocaleProvider 之内，不渲染任何内容。 */
export function UnsavedGuard(): null {
  useUnsavedGuard()
  return null
}

function useUnsavedGuard(): void {
  const { t } = useLocale()
  useDraftVersion()
  const dirty = hasDrafts()

  useEffect(() => {
    void window.pigcodeNative
      ?.setUnsavedLabels?.({
        message: t("files.discard.title"),
        detail: t("files.discard.window"),
        discard: t("files.discard.confirm"),
        cancel: t("files.discard.cancel"),
      })
      .catch(() => undefined)
  }, [t])

  useEffect(() => {
    if (!dirty) return undefined
    window.addEventListener("beforeunload", preventUnload)
    return () => window.removeEventListener("beforeunload", preventUnload)
  }, [dirty])
}

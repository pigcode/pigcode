/**
 * 右栏的浏览器标签：工具栏与设备栏来自会话状态，页面区是 BrowserHost 盖上来的 webview。
 * 选择网页元素时把选中的元素作为附件交给当前会话的输入框；选择中按 Esc 取消。
 */
import { useEffect } from "react"
import { requestComposerContext } from "@pigcode/ui-composer"
import { copyText, useLocale } from "@pigcode/ui-primitives"
import { BrowserView, fitViewport } from "@pigcode/ui-workbench"
import { elementContext, isPickedElement } from "./browser-picker"
import { browserSessions, useBrowserVersion } from "./browser-sessions"
import { BrowserSlot } from "./browser-slot"

export function BrowserSurface({ id }: { id: string }) {
  useBrowserVersion()
  const { t } = useLocale()
  const page = browserSessions.page(id)
  const viewport = browserSessions.viewport(id) ?? null
  const slot = browserSessions.slot(id)
  const picking = browserSessions.isPicking(id)

  // 焦点还在应用里（例如刚点过工具栏）时，Esc 同样取消选择。
  useEffect(() => {
    if (!picking) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      browserSessions.cancelPick(id)
      browserSessions.setPicking(id, false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [id, picking])

  /** 开始或取消选择网页元素；选中后加到输入框上方。 */
  async function togglePicker(): Promise<void> {
    if (browserSessions.isPicking(id)) {
      browserSessions.cancelPick(id)
      browserSessions.setPicking(id, false)
      return
    }
    browserSessions.setPicking(id, true)
    try {
      const picked = await browserSessions.pick(id)
      if (!isPickedElement(picked)) return
      const context = elementContext(picked, t)
      requestComposerContext(context)
      browserSessions.setNotice(id, t("browser.picker.added").replace("{element}", context.label))
    } catch {
      browserSessions.setNotice(id, t("browser.picker.failed"), "warn")
    } finally {
      browserSessions.setPicking(id, false)
    }
  }

  return (
    <BrowserView
      page={page}
      viewport={viewport}
      viewportScale={viewport && slot ? fitViewport(slot, viewport).scale : 1}
      picking={picking}
      onNavigate={(url) => browserSessions.load(id, url)}
      onBack={() => browserSessions.command(id, "back")}
      onForward={() => browserSessions.command(id, "forward")}
      onReload={() => browserSessions.command(id, "reload")}
      onStop={() => browserSessions.command(id, "stop")}
      onViewportChange={(next) => browserSessions.setViewport(id, next)}
      onTogglePicker={() => void togglePicker()}
      onOpenDevTools={() => browserSessions.command(id, "devtools")}
      onOpenDefault={(url) => window.pigcodeNative?.browser?.openExternal(url)}
      onCopyUrl={(url) => {
        void copyText(url).then(() => browserSessions.setNotice(id, t("browser.copied")))
      }}
      slot={<BrowserSlot id={id} />}
    />
  )
}

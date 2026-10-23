/** 右栏的浏览器标签：工具栏与 agent 指示来自会话状态，页面区是 BrowserHost 盖上来的 webview。 */
import { BrowserView, type BrowserViewLabels } from "@pigcode/ui-workbench"
import { browserSessions, useBrowserVersion } from "./browser-sessions"
import { BrowserSlot } from "./browser-slot"

export function BrowserSurface({ id, labels }: { id: string; labels: BrowserViewLabels }) {
  useBrowserVersion()
  const page = browserSessions.page(id)
  const activity = browserSessions.activity(id)
  const agent = activity ? { action: activity.action, detail: activity.detail } : null
  return (
    <BrowserView
      page={page}
      agent={agent}
      labels={labels}
      onNavigate={(url) => browserSessions.load(id, url)}
      onBack={() => browserSessions.command(id, "back")}
      onForward={() => browserSessions.command(id, "forward")}
      onReload={() => browserSessions.command(id, "reload")}
      slot={<BrowserSlot id={id} />}
    />
  )
}

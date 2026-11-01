/**
 * 浏览器 surface：地址栏、前进后退、刷新、在新窗口打开，下面是页面区。页面本身是宿主盖上来的
 * webview（这里只放占位槽 slot），所以 agent 在后台也能操作它。agent 动手时显示一条指示。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, RotateCw } from "lucide-react"
import { Button, DotMatrix, EmptyState, useLocale, type MessageKey } from "@pigcode/ui-primitives"

/** 在独立窗口打开页面的原生桥签名；测试可注入替身。 */
export type PreviewOpen = (url: string) => Promise<{ id: string }>

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"])

/** 判断地址能否在内置浏览器里打开：只允许 http/https。 */
export function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * 把地址栏输入补全为完整 URL：「3000」→ http://localhost:3000，「localhost:5173/a」与 IP 补 http://，
 * 其他主机名补 https://。不是 http/https 时返回 null。
 */
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim()
  if (value.length === 0) return null
  let candidate = value
  const hasScheme =
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    /^(about|javascript|data|file|mailto|blob|chrome|devtools|pigcode|pigcode-plugin):/i.test(value)
  if (/^\d{2,5}(\/.*)?$/.test(value)) candidate = `http://localhost:${value}`
  else if (!hasScheme) {
    const host = value.split(/[/?#]/)[0]?.replace(/:\d+$/, "").toLowerCase() ?? ""
    const local = LOCAL_HOSTS.has(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)
    candidate = `${local ? "http" : "https"}://${value}`
  }
  try {
    const url = new URL(candidate)
    return isBrowserUrl(url.href) ? url.href : null
  } catch {
    return null
  }
}

/** agent 动作名对应的文案；没有列出的动作原样显示。 */
const ACTION_LABELS: Record<string, MessageKey> = {
  open: "browser.action.open",
  navigate: "browser.action.navigate",
  back: "browser.action.back",
  forward: "browser.action.forward",
  reload: "browser.action.reload",
  snapshot: "browser.action.snapshot",
  click: "browser.action.click",
  type: "browser.action.type",
  press: "browser.action.press",
  scroll: "browser.action.scroll",
  wait: "browser.action.wait",
  evaluate: "browser.action.evaluate",
  screenshot: "browser.action.screenshot",
}

/** 页面状态，来自 webview 的导航事件。 */
export interface BrowserPageView {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** agent 最近一次在这个浏览器里的动作。 */
export interface BrowserAgentView {
  action: string
  detail: string
}

/** 默认通过 preload 暴露的 pigcodeNative 打开窗口。 */
function openInNativeWindow(url: string): Promise<{ id: string }> {
  const bridge = typeof window === "undefined" ? undefined : window.pigcodeNative
  if (!bridge?.previewOpen) return Promise.reject(new Error("PREVIEW_BRIDGE_UNAVAILABLE"))
  return bridge.previewOpen(url)
}

/** 把主进程错误码映射成可读文案；未知错误原样展示。 */
function openError(error: unknown, t: (key: MessageKey) => string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("PREVIEW_URL_NOT_ALLOWED")) return t("preview.invalid")
  if (message.includes("PREVIEW_BRIDGE_UNAVAILABLE")) return t("preview.bridgeMissing")
  return message
}

/** 浏览器属性。 */
export interface BrowserViewProps {
  page: BrowserPageView
  agent?: BrowserAgentView | null | undefined
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  openExternal?: PreviewOpen
  /** 页面区的占位槽；宿主把 webview 盖在它上面。 */
  slot: ReactNode
}

/** 浏览器 surface。 */
export function BrowserView({
  page,
  agent,
  onNavigate,
  onBack,
  onForward,
  onReload,
  openExternal = openInNativeWindow,
  slot,
}: BrowserViewProps) {
  const { t } = useLocale()
  const invalid = t("preview.invalid")
  const actionKey = agent ? ACTION_LABELS[agent.action] : undefined
  const current = page.url && page.url !== "about:blank" ? page.url : ""
  const [address, setAddress] = useState(current)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) setAddress(current)
  }, [current, editing])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const url = normalizeBrowserUrl(address)
    if (!url) {
      setError(invalid)
      return
    }
    setError(null)
    setAddress(url)
    setEditing(false)
    if (url === current) onReload()
    else onNavigate(url)
  }

  async function openWindow(): Promise<void> {
    if (!current) return
    setError(null)
    try {
      await openExternal(current)
    } catch (cause) {
      setError(openError(cause, t))
    }
  }

  return (
    <div className="browser-view" data-agent={agent ? true : undefined}>
      <div className="browser-toolbar">
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("browser.back")}
          title={t("browser.back")}
          disabled={!page.canGoBack}
          onClick={onBack}
        >
          <ArrowLeft className="ic ic-sm" aria-hidden="true" />
        </Button>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("browser.forward")}
          title={t("browser.forward")}
          disabled={!page.canGoForward}
          onClick={onForward}
        >
          <ArrowRight className="ic ic-sm" aria-hidden="true" />
        </Button>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("browser.reload")}
          title={t("browser.reload")}
          disabled={!current}
          onClick={onReload}
        >
          <RotateCw className="ic ic-sm" aria-hidden="true" data-spin={page.loading || undefined} />
        </Button>
        <form className="browser-address" onSubmit={submit}>
          <input
            type="text"
            value={address}
            placeholder={t("browser.address")}
            aria-label={t("browser.address")}
            aria-invalid={error === invalid || undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setEditing(true)
              setAddress(event.target.value)
            }}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setEditing(false)}
          />
        </form>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("browser.external")}
          title={t("browser.external")}
          disabled={!current}
          onClick={() => void openWindow()}
        >
          <ExternalLink className="ic ic-sm" aria-hidden="true" />
        </Button>
      </div>
      {agent ? (
        <div className="browser-agent" role="status" aria-live="polite">
          <Bot className="ic ic-sm" aria-hidden="true" />
          <span className="browser-agent-label">{t("browser.agent")}</span>
          <span className="browser-agent-action truncate">
            {[actionKey ? t(actionKey) : agent.action, agent.detail].filter(Boolean).join(" · ")}
          </span>
          <DotMatrix />
        </div>
      ) : null}
      {error ? (
        <p className="browser-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="browser-page">
        {current ? null : (
          <EmptyState
            icon={<Globe className="ic" />}
            title={t("browser.empty")}
            description={t("browser.emptyHint")}
          />
        )}
        {slot}
      </div>
    </div>
  )
}

/**
 * 浏览器 surface：地址栏、前进后退、刷新、在新窗口打开，下面是页面区。页面本身是宿主盖上来的
 * webview（这里只放占位槽 slot），所以 agent 在后台也能操作它。agent 动手时显示一条指示。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, RotateCw } from "lucide-react"
import { Button, DotMatrix } from "@pigcode/ui-primitives"

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

/** 浏览器文案；容器按 locale 注入。 */
export interface BrowserViewLabels {
  address: string
  back: string
  forward: string
  reload: string
  external: string
  empty: string
  emptyHint: string
  invalid: string
  bridgeMissing: string
  agent: string
  actions: Record<string, string>
}

/** 默认中文文案。 */
export const DEFAULT_BROWSER_LABELS: BrowserViewLabels = {
  address: "输入网址，例如 localhost:3000",
  back: "后退",
  forward: "前进",
  reload: "重新加载",
  external: "在新窗口打开",
  empty: "还没有打开页面",
  emptyHint: "输入网址，或者让 agent 打开 dev server 检查页面。",
  invalid: "只支持 http/https 网址",
  bridgeMissing: "当前环境不支持预览窗口",
  agent: "Agent 正在操作",
  actions: {
    open: "打开",
    navigate: "打开",
    back: "后退",
    forward: "前进",
    reload: "刷新",
    snapshot: "读取页面",
    click: "点击",
    type: "输入",
    press: "按键",
    scroll: "滚动",
    wait: "等待",
    evaluate: "执行脚本",
    screenshot: "截图",
  },
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
function openError(error: unknown, labels: BrowserViewLabels): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("PREVIEW_URL_NOT_ALLOWED")) return labels.invalid
  if (message.includes("PREVIEW_BRIDGE_UNAVAILABLE")) return labels.bridgeMissing
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
  labels?: Partial<BrowserViewLabels>
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
  labels: overrides,
}: BrowserViewProps) {
  const labels: BrowserViewLabels = {
    ...DEFAULT_BROWSER_LABELS,
    ...overrides,
    actions: { ...DEFAULT_BROWSER_LABELS.actions, ...overrides?.actions },
  }
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
      setError(labels.invalid)
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
      setError(openError(cause, labels))
    }
  }

  return (
    <div className="browser-view" data-agent={agent ? true : undefined}>
      <div className="browser-toolbar">
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={labels.back}
          title={labels.back}
          disabled={!page.canGoBack}
          onClick={onBack}
        >
          <ArrowLeft className="ic ic-sm" aria-hidden="true" />
        </Button>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={labels.forward}
          title={labels.forward}
          disabled={!page.canGoForward}
          onClick={onForward}
        >
          <ArrowRight className="ic ic-sm" aria-hidden="true" />
        </Button>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={labels.reload}
          title={labels.reload}
          disabled={!current}
          onClick={onReload}
        >
          <RotateCw className="ic ic-sm" aria-hidden="true" data-spin={page.loading || undefined} />
        </Button>
        <form className="browser-address" onSubmit={submit}>
          <input
            type="text"
            value={address}
            placeholder={labels.address}
            aria-label={labels.address}
            aria-invalid={error === labels.invalid || undefined}
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
          aria-label={labels.external}
          title={labels.external}
          disabled={!current}
          onClick={() => void openWindow()}
        >
          <ExternalLink className="ic ic-sm" aria-hidden="true" />
        </Button>
      </div>
      {agent ? (
        <div className="browser-agent" role="status" aria-live="polite">
          <Bot className="ic ic-sm" aria-hidden="true" />
          <span className="browser-agent-label">{labels.agent}</span>
          <span className="browser-agent-action truncate">
            {[labels.actions[agent.action] ?? agent.action, agent.detail]
              .filter(Boolean)
              .join(" · ")}
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
          <div className="browser-empty">
            <span className="browser-empty-icon">
              <Globe className="ic" aria-hidden="true" />
            </span>
            <strong>{labels.empty}</strong>
            <p>{labels.emptyHint}</p>
          </div>
        )}
        {slot}
      </div>
    </div>
  )
}

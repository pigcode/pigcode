/** 预览面板：输入 loopback URL，通过原生桥在独立沙箱窗口打开。 */
import { useState, type FormEvent } from "react"
import { Button, Input } from "@pigcode/ui-primitives"

/** 默认预览地址；与常见前端 dev server 对齐。 */
export const DEFAULT_PREVIEW_URL = "http://localhost:3000"

/** 打开预览的原生桥签名；测试可注入替身。 */
export type PreviewOpen = (url: string) => Promise<{ id: string }>

/** 预览面板文案；容器按当前 locale 注入，组件本身保持无 locale 依赖。 */
export interface PreviewPanelLabels {
  url: string
  urlPlaceholder: string
  open: string
  opening: string
  hint: string
  invalid: string
  bridgeMissing: string
}

/** 默认中文文案；未注入 labels 时使用。 */
export const DEFAULT_PREVIEW_LABELS: PreviewPanelLabels = {
  url: "本地地址",
  urlPlaceholder: DEFAULT_PREVIEW_URL,
  open: "打开预览",
  opening: "正在打开…",
  hint: "仅支持 localhost、127.0.0.1 与 [::1] 的 http/https 地址；预览在独立窗口中打开。",
  invalid: "仅支持本地 http/https 地址（localhost、127.0.0.1、[::1]）",
  bridgeMissing: "当前环境不支持预览窗口",
}

/** 默认通过 preload 暴露的 pigcodeNative 打开窗口。 */
function openInNativeWindow(url: string): Promise<{ id: string }> {
  const bridge = typeof window === "undefined" ? undefined : window.pigcodeNative
  if (!bridge?.previewOpen) return Promise.reject(new Error("PREVIEW_BRIDGE_UNAVAILABLE"))
  return bridge.previewOpen(url)
}

/** 把主进程错误码映射成可读文案；未知错误原样展示。 */
function previewError(error: unknown, labels: PreviewPanelLabels): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("PREVIEW_URL_NOT_ALLOWED")) return labels.invalid
  if (message.includes("PREVIEW_BRIDGE_UNAVAILABLE")) return labels.bridgeMissing
  return message
}

/** 预览面板属性；不内嵌 iframe，点击后由 Electron 子窗口打开。 */
export interface PreviewPanelProps {
  open?: PreviewOpen
  labels?: Partial<PreviewPanelLabels>
}

/** 预览面板入口；打开失败时保留输入并展示错误。 */
export function PreviewPanel({ open = openInNativeWindow, labels: overrides }: PreviewPanelProps) {
  const labels: PreviewPanelLabels = { ...DEFAULT_PREVIEW_LABELS, ...overrides }
  const [url, setUrl] = useState(DEFAULT_PREVIEW_URL)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const trimmed = url.trim()

  /** 提交表单；空地址或打开中忽略重复点击。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (trimmed.length === 0 || opening) return

    setOpening(true)
    setError(null)
    try {
      await open(trimmed)
    } catch (cause) {
      setError(previewError(cause, labels))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="preview-panel">
      <form className="preview-form" onSubmit={(event) => void submit(event)}>
        <label className="preview-field">
          <span>{labels.url}</span>
          <Input
            value={url}
            placeholder={labels.urlPlaceholder}
            disabled={opening}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <Button type="submit" size="sm" disabled={opening || trimmed.length === 0}>
          {opening ? labels.opening : labels.open}
        </Button>
      </form>
      <p className="workbench-empty">{labels.hint}</p>
      {error ? (
        <p className="workbench-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

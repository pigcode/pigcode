/**
 * 浏览器工具栏：后退、前进、重新加载（加载中换成停止），中间是胶囊形的地址栏——没聚焦时网址居中，
 * 左边是网站图标或连接类型；聚焦后左对齐并全选。右边是响应式视图、选择网页元素和更多菜单。
 * 加载时底边有一条进度线。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  AppWindow,
  Bug,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  Globe,
  Lock,
  LockOpen,
  MonitorSmartphone,
  RotateCw,
  SquareMousePointer,
  X,
} from "lucide-react"
import { Button, Menu, useLocale } from "@pigcode/ui-primitives"
import { connectionOf, isLocalBrowserUrl, normalizeBrowserUrl } from "./browser-url"

/** 工具栏上的图标按钮；pressed 不为 undefined 时是开关。 */
function ToolButton({
  label,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean | undefined
  pressed?: boolean | undefined
  onClick?: (() => void) | undefined
  children: ReactNode
}) {
  return (
    <Button
      variant="plain"
      size="icon"
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** 地址栏左边：网站图标，读不到时按连接类型显示锁或地球。 */
function SiteIcon({ url, favicon }: { url: string; favicon?: string | null | undefined }) {
  const { t } = useLocale()
  const [broken, setBroken] = useState<string | null>(null)
  const connection = connectionOf(url)
  const label =
    connection === "secure"
      ? t("browser.secure")
      : connection === "insecure"
        ? t("browser.insecure")
        : undefined
  return (
    <span className="browser-site" data-connection={connection ?? undefined} title={label}>
      {favicon && broken !== favicon ? (
        <img src={favicon} alt="" draggable={false} onError={() => setBroken(favicon)} />
      ) : connection === "secure" ? (
        <Lock className="ic ic-sm" aria-hidden="true" />
      ) : connection === "insecure" ? (
        <LockOpen className="ic ic-sm" aria-hidden="true" />
      ) : (
        <Globe className="ic ic-sm" aria-hidden="true" />
      )}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export interface BrowserToolbarProps {
  /** 当前页面的地址；没有页面时为空串。 */
  url: string
  favicon?: string | null | undefined
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  responsive: boolean
  picking: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop?: (() => void) | undefined
  onToggleResponsive?: (() => void) | undefined
  onTogglePicker?: (() => void) | undefined
  onOpenDefault?: (() => void) | undefined
  onOpenWindow?: (() => void) | undefined
  onCopyUrl?: (() => void) | undefined
  onOpenDevTools?: (() => void) | undefined
  /** 地址栏输入不合法时的提示；合法时为 null。 */
  onInvalid: (message: string | null) => void
}

export function BrowserToolbar({
  url,
  favicon,
  loading,
  canGoBack,
  canGoForward,
  responsive,
  picking,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleResponsive,
  onTogglePicker,
  onOpenDefault,
  onOpenWindow,
  onCopyUrl,
  onOpenDevTools,
  onInvalid,
}: BrowserToolbarProps) {
  const { t } = useLocale()
  const [address, setAddress] = useState(url)
  const [editing, setEditing] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!editing) setAddress(url)
  }, [url, editing])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const next = normalizeBrowserUrl(address)
    if (!next) {
      onInvalid(t("preview.invalid"))
      return
    }
    onInvalid(null)
    setAddress(next)
    setEditing(false)
    if (next === url) onReload()
    else onNavigate(next)
  }

  return (
    <div className="browser-toolbar">
      <ToolButton label={t("browser.back")} disabled={!canGoBack} onClick={onBack}>
        <ChevronLeft className="ic" aria-hidden="true" />
      </ToolButton>
      <ToolButton label={t("browser.forward")} disabled={!canGoForward} onClick={onForward}>
        <ChevronRight className="ic" aria-hidden="true" />
      </ToolButton>
      {loading && onStop ? (
        <ToolButton label={t("browser.stop")} onClick={onStop}>
          <X className="ic" aria-hidden="true" />
        </ToolButton>
      ) : (
        <ToolButton label={t("browser.reload")} disabled={!url} onClick={onReload}>
          <RotateCw className="ic ic-sm" aria-hidden="true" />
        </ToolButton>
      )}
      <form
        className="browser-address"
        data-focused={focused || undefined}
        data-empty={url ? undefined : ""}
        onSubmit={submit}
      >
        {url ? <SiteIcon url={url} favicon={favicon} /> : null}
        <input
          type="text"
          value={address}
          placeholder={t("browser.address")}
          aria-label={t("browser.address")}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setEditing(true)
            setAddress(event.target.value)
          }}
          onFocus={(event) => {
            setFocused(true)
            event.currentTarget.select()
          }}
          onBlur={() => {
            setFocused(false)
            setEditing(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            setEditing(false)
            setAddress(url)
            event.currentTarget.blur()
          }}
        />
      </form>
      <ToolButton
        label={responsive ? t("browser.responsive.exit") : t("browser.responsive.enter")}
        pressed={responsive}
        onClick={onToggleResponsive}
      >
        <MonitorSmartphone className="ic ic-sm" aria-hidden="true" />
      </ToolButton>
      <ToolButton
        label={picking ? t("browser.picker.cancel") : t("browser.picker.start")}
        pressed={picking}
        disabled={!url}
        onClick={onTogglePicker}
      >
        <SquareMousePointer className="ic ic-sm" aria-hidden="true" />
      </ToolButton>
      <Menu.Root>
        <Menu.Trigger
          className="btn btn-icon browser-more"
          aria-label={t("browser.more")}
          title={t("browser.more")}
        >
          <Ellipsis className="ic ic-sm" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="browser-menu">
              <Menu.Item disabled={!url || !onOpenDefault} onClick={onOpenDefault}>
                <ExternalLink className="ic ic-sm" aria-hidden="true" />
                {t("browser.openDefault")}
              </Menu.Item>
              <Menu.Item
                disabled={!url || !isLocalBrowserUrl(url) || !onOpenWindow}
                onClick={onOpenWindow}
              >
                <AppWindow className="ic ic-sm" aria-hidden="true" />
                {t("browser.external")}
              </Menu.Item>
              <Menu.Item disabled={!url || !onCopyUrl} onClick={onCopyUrl}>
                <Copy className="ic ic-sm" aria-hidden="true" />
                {t("browser.copyUrl")}
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item disabled={!onOpenDevTools} onClick={onOpenDevTools}>
                <Bug className="ic ic-sm" aria-hidden="true" />
                {t("browser.devtools")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {loading ? (
        <span className="browser-progress" role="progressbar" aria-label={t("browser.loading")} />
      ) : null}
    </div>
  )
}

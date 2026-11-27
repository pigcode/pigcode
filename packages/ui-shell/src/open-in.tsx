/**
 * 在本机应用里打开项目文件夹：新会话页顶栏与文件标签的分段按钮（左边用上次选的应用打开，右边展开
 * 应用列表）、会话详情卡里同样分成两半的一行，以及侧栏项目菜单里的「在文件管理器中打开」。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Menu, copyText, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { useToast } from "./toast"
import { nativePlatform } from "./window-state"

/** 本机装了的一个应用。 */
export interface OpenApp {
  id: string
  name: string
  kind: "file-manager" | "editor" | "terminal"
  icon: string | null
}

const PREFERRED_KEY = "pigcode.openInApp"
const FILE_PREFERRED_KEY = "pigcode.openInFileApp"

/** 按系统习惯称呼文件管理器：访达、资源管理器，其他平台统称文件管理器。 */
export function revealLabelKey(platform: string = nativePlatform()): MessageKey {
  if (platform === "darwin") return "openIn.finder"
  if (platform === "win32") return "openIn.explorer"
  return "openIn.fileManager"
}

/** 在系统文件管理器里打开文件夹；没有原生桥或文件夹已不存在时抛错。 */
export async function openFolder(path: string): Promise<void> {
  const open = window.pigcodeNative?.openFolder
  if (!open) throw new Error("FOLDER_NOT_FOUND")
  await open(path)
}

/** 打开失败时的提示；原生桥的错误码对用户没有意义，只显示文件夹路径。 */
export function useOpenFailure(): (path: string) => void {
  const { t } = useLocale()
  const toast = useToast()
  return (path) => toast(`${t("openIn.failed")} ${path}`, "alert")
}

/** 读取上次选的应用。 */
function readPreferred(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 本机应用列表；挂载时取一次，菜单每次打开再刷新，装了新应用不用重启；远程主机跳过查询。 */
function useOpenApps(enabled = true): [OpenApp[], () => void] {
  const [apps, setApps] = useState<OpenApp[]>([])
  const refresh = useCallback(() => {
    if (!enabled) return
    const pending = window.pigcodeNative?.listOpenApps?.()
    if (!pending) {
      setApps([])
      return
    }
    void pending.then(setApps).catch(() => setApps([]))
  }, [enabled])
  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, refresh])
  return [apps, refresh]
}

/** 应用图标；拿不到图标时显示名字的首字母。 */
export function AppIcon({ app }: { app: OpenApp }) {
  if (app.icon) return <img className="app-icon" src={app.icon} alt="" draggable={false} />
  return (
    <span className="app-icon is-letter" data-kind={app.kind} aria-hidden="true">
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Windows 与 Linux 的文件管理器用本地化的称呼，其他应用用自己的名字。 */
function useAppName(): (app: OpenApp) => string {
  const { t } = useLocale()
  return (app) =>
    app.id === "explorer"
      ? t("openIn.app.explorer")
      : app.id === "file-manager"
        ? t("openIn.app.files")
        : app.name
}

interface OpenInProps {
  /** 用于复制路径和显示错误的绝对路径。 */
  path: string
  /** 远程主机上的路径不能通过本机 Finder / 外部编辑器打开，仅保留路径复制。 */
  isRemote?: boolean | undefined
  /** 传入时打开当前文件，appId 为 null 时交给系统默认应用。 */
  openFile?: ((appId: string | null) => Promise<void>) | undefined
}

/** 分段按钮和详情卡里那一行共用：可选的应用、记住的选择、打开失败的提示。 */
function useOpenIn({ path, isRemote = false, openFile }: OpenInProps) {
  const { t } = useLocale()
  const toast = useToast()
  const nameOf = useAppName()
  const [apps, refresh] = useOpenApps(!isRemote)
  const preferenceKey = openFile ? FILE_PREFERRED_KEY : PREFERRED_KEY
  const [preferred, setPreferred] = useState(() => readPreferred(preferenceKey))
  const choices = isRemote ? [] : openFile ? apps.filter((app) => app.kind === "editor") : apps
  const selected = isRemote
    ? undefined
    : (choices.find((app) => app.id === preferred) ?? (openFile ? null : choices[0]))

  function open(app: OpenApp | null | undefined): void {
    const id = app?.id ?? null
    setPreferred(id)
    try {
      if (id) window.localStorage.setItem(preferenceKey, id)
      else window.localStorage.removeItem(preferenceKey)
    } catch {
      // 存储不可用时只记在当前按钮里。
    }
    const opened = openFile
      ? openFile(id)
      : app
        ? window.pigcodeNative?.openWithApp?.(app.id, path)
        : undefined
    if (opened) {
      const failed = t(openFile ? "files.menu.openFailed" : "openIn.failed")
      void opened.catch(() => toast(`${failed} ${path}`, "alert"))
    }
  }

  // 文件管理器按系统习惯说「在访达中打开」，其他应用说「用 Cursor 打开」。
  const openLabel = !selected
    ? t("files.menu.defaultApp")
    : selected.kind === "file-manager"
      ? t(revealLabelKey())
      : t("openIn.editor").replace("{name}", nameOf(selected))

  /** 右半边展开的应用列表，末尾是复制路径。 */
  function menu(trigger: { className: string; children: ReactNode }) {
    return (
      <Menu.Root
        onOpenChange={(next) => {
          if (next) refresh()
        }}
      >
        <Menu.Trigger
          className={trigger.className}
          type="button"
          aria-label={t("openIn.choose")}
          title={t("openIn.choose")}
        >
          {trigger.children}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="open-in-menu">
              {choices.map((app) => (
                <Menu.Item key={app.id} className="open-in-item" onClick={() => open(app)}>
                  <AppIcon app={app} />
                  <span className="grow">{nameOf(app)}</span>
                  {app.id === selected?.id ? (
                    <Icon name="check" small className="check-mark" />
                  ) : null}
                </Menu.Item>
              ))}
              {openFile ? (
                <Menu.Item onClick={() => open(null)}>
                  <Icon name="file" small />
                  <span className="grow">{t("files.menu.defaultApp")}</span>
                  {!selected ? <Icon name="check" small className="check-mark" /> : null}
                </Menu.Item>
              ) : null}
              <Menu.Separator />
              <Menu.Item
                onClick={() => {
                  void copyText(path).then(() => toast(t("openIn.copied")))
                }}
              >
                <Icon name="copy" small />
                <span className="grow">{t("openIn.copyPath")}</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    )
  }

  return {
    selected,
    open,
    openLabel,
    menu,
    groupLabel: t(openFile ? "files.menu.openWith" : "openIn.title"),
    /** 打开项目时一个应用都没有就不显示入口；打开文件时还能交给系统默认应用。 */
    hidden: !selected && !openFile,
  }
}

/** 文件与项目共用「打开」分段按钮，按目标类型记住打开方式；远程主机隐藏本机应用打开入口。 */
export function OpenInButton(props: OpenInProps) {
  const openIn = useOpenIn(props)
  if (props.isRemote || openIn.hidden) return null
  const { selected, openLabel } = openIn
  return (
    <div className="open-in-split" role="group" aria-label={openIn.groupLabel}>
      <button
        type="button"
        className="open-in-main"
        aria-label={openLabel}
        title={openLabel}
        onClick={() => openIn.open(selected)}
      >
        {selected ? <AppIcon app={selected} /> : <Icon name="file" />}
      </button>
      {openIn.menu({ className: "open-in-more", children: <Icon name="down" /> })}
    </div>
  )
}

/**
 * 会话详情卡里的「打开」：左边整行写着用哪个应用打开，右边的箭头换应用。打开项目的选择只记一份，
 * 会话和新会话草稿的详情卡共用；远程主机只提供复制远端路径。
 */
export function OpenInRow({
  path,
  isRemote = false,
}: {
  path: string
  isRemote?: boolean | undefined
}) {
  const { t } = useLocale()
  const toast = useToast()
  const openIn = useOpenIn({ path, isRemote })
  if (isRemote) {
    return (
      <button
        type="button"
        className="details-row"
        title={t("hosts.remoteOpenInDisabled")}
        onClick={() => void copyText(path).then(() => toast(t("openIn.copied")))}
      >
        <Icon name="copy" />
        <span className="details-row-label">{t("openIn.copyPath")}</span>
      </button>
    )
  }
  if (!openIn.selected) return null
  const { selected } = openIn
  return (
    <div className="details-split" role="group" aria-label={openIn.groupLabel}>
      <button
        type="button"
        className="details-row"
        title={path}
        onClick={() => openIn.open(selected)}
      >
        <AppIcon app={selected} />
        <span className="details-row-label">{openIn.openLabel}</span>
      </button>
      <span className="details-split-sep" aria-hidden="true" />
      {openIn.menu({
        className: "details-split-more",
        children: <ChevronDown className="ic" aria-hidden="true" />,
      })}
    </div>
  )
}

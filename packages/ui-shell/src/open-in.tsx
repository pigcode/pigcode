/**
 * 在本机应用里打开项目文件夹：线程头的分段按钮（左边用上次选的应用打开，右边展开应用列表），
 * 以及侧栏项目菜单里的「在文件管理器中打开」。
 */
import { useCallback, useEffect, useState } from "react"
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
function readPreferred(): string | null {
  try {
    return window.localStorage.getItem(PREFERRED_KEY)
  } catch {
    return null
  }
}

/** 本机应用列表；挂载时取一次，菜单每次打开再刷新，装了新应用不用重启。 */
function useOpenApps(): [OpenApp[], () => void] {
  const [apps, setApps] = useState<OpenApp[]>([])
  const refresh = useCallback(() => {
    void window.pigcodeNative
      ?.listOpenApps?.()
      .then(setApps)
      .catch(() => setApps([]))
  }, [])
  useEffect(refresh, [refresh])
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

/** 线程头右侧的分段按钮：左边用选中的应用打开项目，右边换一个应用或复制路径。 */
export function OpenInButton({ path }: { path: string }) {
  const { t } = useLocale()
  const toast = useToast()
  const failed = useOpenFailure()
  const nameOf = useAppName()
  const [apps, refresh] = useOpenApps()
  const [preferred, setPreferred] = useState<string | null>(readPreferred)
  const selected = apps.find((app) => app.id === preferred) ?? apps[0] ?? null

  function open(app: OpenApp): void {
    setPreferred(app.id)
    try {
      window.localStorage.setItem(PREFERRED_KEY, app.id)
    } catch {
      // 存储不可用时只记在本次运行里。
    }
    void window.pigcodeNative?.openWithApp?.(app.id, path).catch(() => failed(path))
  }

  if (!selected) return null
  const openLabel = t("openIn.editor").replace("{name}", nameOf(selected))
  return (
    <div className="open-in-split" role="group" aria-label={t("openIn.title")}>
      <button
        type="button"
        className="open-in-main"
        aria-label={openLabel}
        title={openLabel}
        onClick={() => open(selected)}
      >
        <AppIcon app={selected} />
      </button>
      <Menu.Root
        onOpenChange={(next) => {
          if (next) refresh()
        }}
      >
        <Menu.Trigger
          className="open-in-more"
          type="button"
          aria-label={t("openIn.choose")}
          title={t("openIn.choose")}
        >
          <Icon name="down" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="open-in-menu">
              {apps.map((app) => (
                <Menu.Item key={app.id} className="open-in-item" onClick={() => open(app)}>
                  <AppIcon app={app} />
                  <span className="grow">{nameOf(app)}</span>
                  {app.id === selected.id ? (
                    <Icon name="check" small className="check-mark" />
                  ) : null}
                </Menu.Item>
              ))}
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
    </div>
  )
}

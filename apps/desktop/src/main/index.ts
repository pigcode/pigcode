/** Electron main：单实例、窗口、Host utilityProcess、原生桥与端口转交。 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
  type MessageBoxSyncOptions,
  type MessagePortMain,
  type Tray,
} from "electron"
import { join } from "node:path"
import {
  pickFolder,
  pickPath,
  readExternalUrl,
  readFolderPickerLabels,
  readPathKind,
} from "./folder-picker"
import { startHostProcess, type HostProcess } from "./host-process"
import { hidesOnClose } from "./lifecycle"
import { readPreferences, withPreference, writePreferences, type Preferences } from "./preferences"
import { applyLoginShellEnv } from "./shell-env"
import { createTray } from "./tray"
import { trayLabels } from "./locale/tray"
import { confirmQuit } from "./quit-prompt"
import { askQuitState, hasPendingWork } from "./quit-check"
import { createUpdates } from "./updates"
import { decideRestart, readHostFatal } from "./host-restart"
import { hostFailureDetail, hostFailureText } from "./locale/host-failure"
import { popupNativeMenu, readMenuPosition, readNativeMenu } from "./native-menu"
import { appIcon } from "./app-icons"
import { appDefsFor, detectApps } from "./open-apps"
import {
  launchCommand,
  launchDetached,
  readDirectory,
  readExistingPath,
  settleOpenPath,
  type OpenAppInfo,
} from "./open-in"
import { setupBrowser } from "./browser-host"
import { registerAppProtocol, registerPluginProtocol, registerPrivilegedSchemes } from "./protocol"
import { closePreview, isAllowedPreviewUrl, openPreview } from "./preview"
import {
  DEFAULT_UNSAVED_LABELS,
  confirmDiscard,
  readUnsavedGuardLabels,
  type UnsavedGuardLabels,
} from "./unsaved-guard"
import {
  TITLE_BAR_HEIGHT,
  createMainWindowOptions,
  readThemeSource,
  readTitleBarColors,
  usesTitleBarOverlay,
} from "./window-options"

registerPrivilegedSchemes()

let host: HostProcess | undefined
let mainWindow: BrowserWindow | undefined
let quitting = false
let unsavedLabels: UnsavedGuardLabels = DEFAULT_UNSAVED_LABELS
/** 连续快速失败的次数与最近一次 Host 报告的失败原因，见 host-restart.ts。 */
let hostQuickFailures = 0
/** 退出流程里停 Host：只停一次，停完才放行 will-quit。 */
let hostStop: Promise<void> | undefined
let hostStopped = false
/** 托盘只在 macOS 和 Windows 上有；创建一次，之后复用。 */
let tray: Tray | undefined
/** 第一次隐藏到托盘时的提示只弹一次。 */
let hiddenHintShown = false
/** 应用偏好；启动时读一次，页面改了立刻写回并生效。 */
let preferences: Preferences = {
  launchAtLogin: false,
  showInDock: true,
  autoCheckUpdates: true,
}
/** Host 的控制端口：退出前经它查询还有多少工作。Host 退出后置空。 */
let hostControlPort: MessagePortMain | undefined
/** 用户在退出确认框里选了退出；之后的 app.quit() 不再重复询问。 */
let quitConfirmed = false
/** 正在进行的退出检查；连点退出时复用。 */
let quitCheck: Promise<void> | undefined
let lastHostFatal: string | null = null
const browser = setupBrowser(() => mainWindow)

/** 把应用内相对路径解析到 app.getAppPath() 之下。 */
export function resolveAppPath(...segments: string[]): string {
  return join(app.getAppPath(), ...segments)
}

/** 偏好跟着 profile 走：并排的多个 profile 各有各的开关，E2E 也不会写到本机的 userData 里。 */
function preferencesPath(): string {
  return join(profileDir(), "preferences.json")
}

/**
 * 把偏好落实到系统上。开机自启只对装好的应用设置：开发时把 Electron 自己写进登录项没有意义，
 * 也会弄脏开发机的设置。
 */
function applyPreferences(next: Preferences): void {
  preferences = next
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
  if (process.platform === "darwin") {
    if (next.showInDock) void app.dock?.show()
    else app.dock?.hide()
    // 藏起 Dock 图标以后，菜单栏图标是唯一的入口。
    if (!next.showInDock) ensureTray()
  }
}

/** 检查更新：启动后一次，之后每 6 小时；同一个版本只提示一次。 */
const updates = createUpdates({
  getWindow: () => mainWindow,
  autoCheck: () => preferences.autoCheckUpdates,
})

function profileDir(): string {
  return process.env.PIGCODE_PROFILE_DIR ?? join(app.getPath("userData"), "profiles", "desktop")
}

/** 注册主题与窗口控制 IPC；只接受已知的动作和外观值。 */
function registerNativeBridge(): void {
  // 设置页显示的版本就是 package.json 的版本，electron 在启动时读一次。
  ipcMain.handle("pigcode:app-version", () => app.getVersion())
  ipcMain.handle("pigcode:set-theme", (_event, value: unknown) => {
    const source = readThemeSource(value)
    if (source) nativeTheme.themeSource = source
  })
  ipcMain.handle("pigcode:window", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === "minimize") window.minimize()
    else if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === "close") window.close()
  })
  ipcMain.handle("pigcode:is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
  ipcMain.handle("pigcode:is-full-screen", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false
  })
  // 原生窗口按钮的底色与图标色跟随页面当前外观；macOS 的交通灯不需要。
  ipcMain.handle("pigcode:title-bar", (event, value: unknown) => {
    const colors = readTitleBarColors(value)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!colors || !window || !usesTitleBarOverlay(process.platform)) return
    window.setTitleBarOverlay({ ...colors, height: TITLE_BAR_HEIGHT })
  })
  // 标题栏菜单由页面描述、主进程弹出原生菜单；返回被点击的命令 id。
  ipcMain.handle("pigcode:menu", (event, items: unknown, position: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const menu = readNativeMenu(items, { allowDevRoles: !app.isPackaged })
    const at = readMenuPosition(position)
    if (!window || !menu || !at) return null
    const zoom = event.sender.getZoomFactor()
    return popupNativeMenu(Menu, window, menu, { x: at.x * zoom, y: at.y * zoom })
  })
  // 创建项目时用系统文件管理器选择源文件夹；返回路径，取消时为 null。
  ipcMain.handle("pigcode:pick-folder", (event, labels: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    return pickFolder(
      (parent, options) => dialog.showOpenDialog(parent, options),
      window,
      readFolderPickerLabels(labels),
    )
  })
  // agent 设置里选可执行文件或配置目录；kind 之外的值直接拒绝。
  ipcMain.handle("pigcode:pick-path", (event, kind: unknown, labels: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const pathKind = readPathKind(kind)
    if (!window || !pathKind) return null
    return pickPath(
      (parent, options) => dialog.showOpenDialog(parent, options),
      window,
      pathKind,
      readFolderPickerLabels(labels),
    )
  })
  ipcMain.handle("pigcode:check-for-updates", () => updates.checkNow())
  ipcMain.handle("pigcode:preferences-get", () => preferences)
  ipcMain.handle("pigcode:preferences-set", (_event, key: unknown, value: unknown) => {
    const next = withPreference(preferences, key, value)
    if (next === preferences) return preferences
    writePreferences(preferencesPath(), next)
    applyPreferences(next)
    // 自动检查的开关改了，定时器跟着起停。
    if (key === "autoCheckUpdates") updates.start()
    return next
  })
  ipcMain.handle("pigcode:unsaved-labels", (_event, value: unknown) => {
    unsavedLabels = readUnsavedGuardLabels(value) ?? unsavedLabels
  })
  // 外部链接（agent 官网）交给系统浏览器；只接受不带凭据的 https。
  ipcMain.handle("pigcode:open-external", async (_event, value: unknown) => {
    const url = readExternalUrl(value)
    if (!url) throw new Error("URL_NOT_ALLOWED")
    await shell.openExternal(url)
  })
  // 文件树的「在文件管理器中显示」：只接受已存在的绝对路径。
  ipcMain.handle("pigcode:reveal-path", (_event, value: unknown) => {
    const path = readExistingPath(value)
    if (!path) throw new Error("PATH_NOT_FOUND")
    shell.showItemInFolder(path)
  })
  // 项目文件夹交给系统文件管理器打开；页面只能传已存在的目录。
  ipcMain.handle("pigcode:open-folder", async (_event, value: unknown) => {
    const folder = readDirectory(value)
    if (!folder) throw new Error("FOLDER_NOT_FOUND")
    const error = await settleOpenPath(shell.openPath(folder))
    if (error) throw new Error(error)
  })
  // 本机装了的文件管理器、编辑器与终端；每次打开菜单都重新检测，图标按位置缓存。
  ipcMain.handle("pigcode:list-open-apps", async (): Promise<OpenAppInfo[]> => {
    const readIcon = (path: string) => app.getFileIcon(path, { size: "normal" })
    return Promise.all(
      detectApps(appDefsFor()).map(async (detected) => ({
        id: detected.def.id,
        name: detected.def.name,
        kind: detected.def.kind,
        icon: await appIcon(detected, readIcon),
      })),
    )
  })
  ipcMain.handle("pigcode:open-with-app", async (_event, appId: unknown, value: unknown) => {
    const folder = readDirectory(value)
    if (!folder) throw new Error("FOLDER_NOT_FOUND")
    const detected = detectApps(appDefsFor()).find((item) => item.def.id === appId)
    if (!detected) throw new Error("APP_NOT_FOUND")
    const launch = launchCommand(detected, folder)
    if (!launch) {
      const error = await settleOpenPath(shell.openPath(folder))
      if (error) throw new Error(error)
      return
    }
    await launchDetached(launch.command, launch.args, folder)
  })
  // 预览窗口：URL 合法性由 preview.ts 统一校验，IPC 只做类型收敛。
  ipcMain.handle("pigcode:preview-open", (_event, url: unknown) => {
    if (typeof url !== "string") throw new Error("PREVIEW_URL_NOT_ALLOWED")
    return openPreview(url)
  })
  ipcMain.handle("pigcode:preview-close", (_event, id: unknown) => {
    if (typeof id === "string") closePreview(id)
    else if (id === undefined || id === null) closePreview()
  })
}

registerNativeBridge()

/** 连续启动失败后不再重启 Host，弹出错误对话框说明原因。 */
function showHostFailure(count: number): void {
  const text = hostFailureText(app.getLocale())
  const options = {
    type: "error" as const,
    message: text.message,
    detail: hostFailureDetail(text, count, lastHostFatal),
  }
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options)
  else void dialog.showMessageBox(options)
}

/** 启动 Host；退出后按 host-restart.ts 的策略退避重启，连续快速失败太多次时停下并报错。 */
function startHost(): HostProcess {
  const next = startHostProcess(resolveAppPath("out/host/index.mjs"), profileDir())
  const startedAt = Date.now()
  hostControlPort = next.controlPort
  browser.attachControlPort(next.controlPort)
  next.child.on("message", (message: unknown) => {
    lastHostFatal = readHostFatal(message) ?? lastHostFatal
  })
  next.child.on("exit", () => {
    hostControlPort = undefined
    if (quitting) return
    const decision = decideRestart(hostQuickFailures, Date.now() - startedAt)
    hostQuickFailures = decision.quickFailures
    if (decision.quickFailures === 0) lastHostFatal = null
    if (decision.action === "give-up") {
      host = undefined
      showHostFailure(decision.quickFailures)
      return
    }
    setTimeout(() => {
      if (quitting) return
      host = startHost()
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.postMessage("pigcode:port", null, [host.appPort])
      }
    }, decision.delayMs)
  })
  return next
}

/** 托盘：隐藏窗口以后从这里找回窗口或退出。Linux 没有托盘（关窗口直接退出）。 */
function ensureTray(): void {
  if (tray || !hidesOnClose()) return
  tray = createTray(app.getLocale(), {
    show: () => showWindow(),
    quit: () => app.quit(),
  })
}

/** 第一次隐藏到托盘时提示一下；Windows 上关窗口后应用还在运行，不说明会让人以为已经退出。 */
function showHiddenHint(): void {
  if (process.platform !== "win32" || hiddenHintShown || !Notification.isSupported()) return
  hiddenHintShown = true
  const labels = trayLabels(app.getLocale())
  new Notification({ title: labels.hiddenTitle, body: labels.hiddenBody }).show()
}

/** 正在创建的主窗口。启动过程中 activate 或 second-instance 再来一次时复用，不会开出两个窗口。 */
let openingWindow: Promise<BrowserWindow> | undefined

/** 创建主窗口；同时只创建一个。 */
function openMainWindow(): Promise<BrowserWindow> {
  openingWindow ??= createWindow().finally(() => {
    openingWindow = undefined
  })
  return openingWindow
}

/** 把窗口带到前台；窗口已经被关掉（Linux 或异常）时重新创建一个。 */
function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  void openMainWindow().then((window) => {
    mainWindow = window
    window.show()
    window.focus()
  })
}

/** 创建调试窗口，并在页面加载后把 Host 的 MessagePort 交给渲染进程。 */
export async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(
    createMainWindowOptions({
      platform: process.platform,
      preloadPath: resolveAppPath("out/preload/index.cjs"),
      isPackaged: app.isPackaged,
      dark: nativeTheme.shouldUseDarkColors,
    }),
  )
  window.once("ready-to-show", () => window.show())
  // macOS 全屏时交通灯隐藏，页面据此收回为交通灯预留的空间。
  window.on("enter-full-screen", () => window.webContents.send("pigcode:full-screen", true))
  window.on("leave-full-screen", () => window.webContents.send("pigcode:full-screen", false))
  // 右侧浏览器用 iframe 内嵌本机页面；子框架的跳转与重定向同样只能留在 loopback。
  const guardFrame = (event: { isMainFrame: boolean; url: string; preventDefault: () => void }) => {
    if (!event.isMainFrame && /^https?:/i.test(event.url) && !isAllowedPreviewUrl(event.url)) {
      event.preventDefault()
    }
  }
  window.webContents.on("will-frame-navigate", guardFrame)
  window.webContents.on("will-redirect", guardFrame)
  // 页面有未保存的文件修改时会阻止卸载；preventDefault 表示用户确认放弃，继续关闭或刷新。
  window.webContents.on("will-prevent-unload", (event) => {
    // 窗口隐藏到托盘时退出也要看得见确认框；macOS 上挂在隐藏窗口上的 sheet 不会显示。
    if (!window.isVisible()) window.show()
    const show = (options: MessageBoxSyncOptions) => dialog.showMessageBoxSync(window, options)
    if (confirmDiscard(show, unsavedLabels)) {
      event.preventDefault()
      return
    }
    // 用户选了「继续编辑」，退出被取消：之后的关窗口又是隐藏而不是退出，下次退出要重新确认。
    quitting = false
    quitConfirmed = false
  })
  window.webContents.on("did-finish-load", () => {
    if (host) window.webContents.postMessage("pigcode:port", null, [host.appPort])
  })
  window.on("close", (event) => {
    if (quitting || !hidesOnClose()) return
    // 关窗口只是隐藏：Host、agent run 和终端都继续运行，从托盘或 Dock 能找回窗口。
    event.preventDefault()
    window.hide()
    ensureTray()
    showHiddenHint()
  })
  await window.loadURL("pigcode://app/index.html")
  return window
}

/**
 * 默认 profile 只允许一个实例：两个 Host 同时读写一份数据库与 settings.json 会互相覆盖。
 * 再次启动时把已有窗口带到前台后退出。显式指定 PIGCODE_PROFILE_DIR（E2E、并排的多个 profile）不加锁。
 */
const singleInstance = process.env.PIGCODE_PROFILE_DIR === undefined
if (singleInstance && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => showWindow())
  // 提前开始读，Electron 准备好的这段时间也算在内，窗口少等一会儿。
  const shellEnv = applyLoginShellEnv()
  app.whenReady().then(async () => {
    registerAppProtocol(resolveAppPath("out/renderer"))
    registerPluginProtocol(profileDir())
    // Host 要继承这份环境。窗口也一起等：没有 Host 时界面看着能点，请求却没有回应。
    await shellEnv
    applyPreferences(readPreferences(preferencesPath()))
    updates.start()
    host = startHost()
    mainWindow = await openMainWindow()
    ensureTray()

    if (process.env.PIGCODE_E2E === "1") {
      app.on("pigcode:test-kill-host" as never, () => {
        host?.child.kill()
      })
    }
  })
}

// 窗口都关掉以后才停 Host：退出时窗口可能因为未保存的修改被用户留下，退出随之取消。
// 这里先拦下退出，等 Host 清理完再真正退出，否则 Agent 和终端的进程来不及结束。
app.on("will-quit", (event) => {
  quitting = true
  if (!host || hostStopped) return
  event.preventDefault()
  hostStop ??= host.stop().finally(() => {
    hostStopped = true
    // Host 已经不在时 stop 立刻完成，这里还在 will-quit 的处理过程中；此时调用 app.quit 会被 Electron
    // 忽略（它还在退出流程里），之后又因为 preventDefault 取消了退出，应用就再也退不出去。
    setImmediate(() => app.quit())
  })
})

// macOS 上点 Dock 图标（Windows 上从托盘选「打开窗口」）把隐藏的窗口叫回来。
app.on("activate", () => showWindow())

/** 退出前问一次 Host：有任务在跑时让用户确认，避免一个 Cmd+Q 就把 agent 和终端都停掉。 */
async function checkBeforeQuit(): Promise<void> {
  const port = hostControlPort
  const state = port ? await askQuitState(port) : null
  // Host 不在或没应答时直接退出：没有工作可保，也不能把应用卡住。
  if (!state || !hasPendingWork(state) || (await confirmQuit(() => mainWindow, state))) {
    quitNow()
    return
  }
  // Linux 上关掉窗口就退出了：用户选「继续运行」时窗口已经不在了，把它重新开出来。
  if (!mainWindow || mainWindow.isDestroyed()) {
    quitting = false
    showWindow()
  }
}

/** 记住用户已经确认，再走一次正常的退出流程。 */
function quitNow(): void {
  quitConfirmed = true
  // 在 before-quit 里 preventDefault 之后，这个处理跑完前直接 app.quit() 会被忽略；
  // 等一轮事件循环再退。
  setImmediate(() => app.quit())
}

// 退出流程开始后，关窗口不再隐藏，否则应用退不出去。有任务在跑时先问一次。
app.on("before-quit", (event) => {
  // E2E 默认关掉（见 e2e/projects.ts）：等待审批的用例退出时会撞上原生确认框。
  if (quitConfirmed || process.env.PIGCODE_QUIT_CONFIRM === "0") {
    quitting = true
    return
  }
  event.preventDefault()
  quitCheck ??= checkBeforeQuit()
    .catch(() => quitNow())
    .finally(() => {
      quitCheck = undefined
    })
})

app.on("window-all-closed", () => {
  // 关窗口只是隐藏时这条不会触发；Linux 上关掉最后一个窗口就退出。
  if (hidesOnClose()) return
  quitting = true
  app.quit()
})

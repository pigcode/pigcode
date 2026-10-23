/**
 * 应用图标：macOS 从 .app 的 Info.plist 找到 .icns 再转成 PNG，Windows 取 exe 自带的图标，
 * Linux 从 .desktop 文件的 Icon 字段到图标主题里找。结果以 data URL 交给页面，并按位置缓存。
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { extname, join } from "node:path"
import { promisify } from "node:util"
import type { DetectedApp } from "./open-apps"

const execFileAsync = promisify(execFile)

/** Electron 的 app.getFileIcon 的最小形状；测试可替换。 */
export type FileIconReader = (path: string) => Promise<{ toDataURL(): string; isEmpty(): boolean }>

const cache = new Map<string, Promise<string | null>>()

/** 读取 Info.plist 里声明的图标文件名，按顺序返回存在的 .icns 路径。 */
async function macIconFile(appPath: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "plutil",
    ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")],
    { timeout: 3000 },
  )
  const info = JSON.parse(stdout) as {
    CFBundleIconFile?: string
    CFBundleIconName?: string
    CFBundleIcons?: {
      CFBundlePrimaryIcon?: { CFBundleIconFiles?: string[]; CFBundleIconName?: string }
    }
  }
  const names = [
    info.CFBundleIconFile,
    info.CFBundleIconName,
    info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    ...(info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
  ].filter((name): name is string => typeof name === "string" && name.length > 0)
  for (const name of names) {
    for (const file of name.endsWith(".icns") ? [name] : [`${name}.icns`, name]) {
      const path = join(appPath, "Contents", "Resources", file)
      // Ghostty 这类应用有同名资源目录，必须确认是文件。
      if (existsSync(path) && statSync(path).isFile()) return path
    }
  }
  return null
}

/** 用系统自带的 sips 把 .icns 转成 64px PNG。 */
async function icnsToDataUrl(icnsPath: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-icon-"))
  try {
    const out = join(dir, "icon.png")
    await execFileAsync("sips", ["-s", "format", "png", "-Z", "64", icnsPath, "--out", out], {
      timeout: 5000,
    })
    return `data:image/png;base64,${(await readFile(out)).toString("base64")}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 系统给出的文件图标；拿不到或是空图时返回 null。 */
async function systemIcon(path: string, fileIcon: FileIconReader): Promise<string | null> {
  try {
    const icon = await fileIcon(path)
    return icon.isEmpty() ? null : icon.toDataURL()
  } catch {
    return null
  }
}

const LINUX_DESKTOP_DIRS = [
  join(homedir(), ".local/share/applications"),
  "/usr/local/share/applications",
  "/usr/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  join(homedir(), ".local/share/flatpak/exports/share/applications"),
  "/var/lib/snapd/desktop/applications",
]

const LINUX_ICON_ROOTS = [
  join(homedir(), ".local/share/icons/hicolor"),
  "/usr/local/share/icons/hicolor",
  "/usr/share/icons/hicolor",
  "/var/lib/flatpak/exports/share/icons/hicolor",
  join(homedir(), ".local/share/flatpak/exports/share/icons/hicolor"),
]

const LINUX_ICON_SIZES = ["256x256", "128x128", "96x96", "64x64", "48x48", "scalable"]

/** 找到应用的 .desktop 文件并读出 Icon 字段。snap 的文件名带 `包名_` 前缀。 */
async function desktopIcon(ids: readonly string[]): Promise<string | null> {
  for (const dir of LINUX_DESKTOP_DIRS) {
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const id of ids) {
      const file = files.find((name) => name === `${id}.desktop` || name.endsWith(`_${id}.desktop`))
      if (!file) continue
      const content = await readFile(join(dir, file), "utf8")
      const icon = /^Icon=(.+)$/m.exec(content)?.[1]?.trim()
      if (icon) return icon
    }
  }
  return null
}

/** 把图标名解析成主题里的文件；已经是绝对路径时原样使用。 */
function resolveThemeIcon(icon: string): string | null {
  if (icon.startsWith("/")) return existsSync(icon) ? icon : null
  for (const root of LINUX_ICON_ROOTS) {
    for (const size of LINUX_ICON_SIZES) {
      for (const ext of size === "scalable" ? [".svg"] : [".png", ".svg"]) {
        const path = join(root, size, "apps", `${icon}${ext}`)
        if (existsSync(path)) return path
      }
    }
  }
  for (const ext of [".png", ".svg"]) {
    const path = join("/usr/share/pixmaps", `${icon}${ext}`)
    if (existsSync(path)) return path
  }
  return null
}

/** PNG 与 SVG 图标文件转成 data URL；其他格式（例如 xpm）放弃。 */
async function fileToDataUrl(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  const mime = ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : null
  if (!mime) return null
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`
}

/** Linux：.desktop → Icon → 主题文件；找不到时用通用的类别图标。 */
async function linuxIcon(app: DetectedApp): Promise<string | null> {
  const fallback =
    app.def.kind === "file-manager"
      ? ["system-file-manager", "org.gnome.Nautilus", "folder"]
      : app.def.kind === "terminal"
        ? ["utilities-terminal", "org.gnome.Terminal"]
        : []
  const named = app.def.desktopIds ? await desktopIcon(app.def.desktopIds) : null
  for (const icon of [named, ...fallback]) {
    if (!icon) continue
    const path = resolveThemeIcon(icon)
    if (path) {
      const url = await fileToDataUrl(path)
      if (url) return url
    }
  }
  return null
}

/** 读取一个应用的图标；同一位置只读一次。失败时返回 null，页面显示首字母。 */
export function appIcon(
  app: DetectedApp,
  fileIcon: FileIconReader,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const key = `${platform}:${app.def.id}:${app.location}`
  let pending = cache.get(key)
  if (!pending) {
    pending = (async () => {
      if (platform === "darwin") {
        const icns = await macIconFile(app.location).catch(() => null)
        const url = icns ? await icnsToDataUrl(icns).catch(() => null) : null
        return url ?? systemIcon(app.location, fileIcon)
      }
      if (platform === "win32") return app.location ? systemIcon(app.location, fileIcon) : null
      return linuxIcon(app)
    })().catch(() => null)
    cache.set(key, pending)
  }
  return pending
}

/** 测试用：清空图标缓存。 */
export function clearAppIconCache(): void {
  cache.clear()
}

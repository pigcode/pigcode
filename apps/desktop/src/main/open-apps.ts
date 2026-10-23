/**
 * 「用…打开」的应用：文件管理器、编辑器与终端。按平台登记候选位置，只列出本机装了的。
 * 应用清单参考 ZCode 的编辑器检测（macOS 看 .app，Windows 看安装目录，Linux 看 PATH 上的命令）。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, win32 } from "node:path"

/** 应用的类别；列表按文件管理器、编辑器、终端排序。 */
export type OpenAppKind = "file-manager" | "editor" | "terminal"

/** 一个候选应用；同一 id 在各平台各有一份定义。 */
export interface OpenAppDef {
  id: string
  name: string
  kind: OpenAppKind
  /** macOS：候选 .app 路径。 */
  bundles?: string[]
  /** Windows：候选可执行文件路径。 */
  executables?: string[]
  /** Linux：PATH 上的候选命令，以及打开文件夹的参数。 */
  commands?: string[]
  args?: (folder: string) => string[]
  /** Linux：用来找图标的 .desktop 文件名。 */
  desktopIds?: string[]
}

/** 检测到的应用：定义加上实际找到的位置。 */
export interface DetectedApp {
  def: OpenAppDef
  /** macOS 的 .app、Windows 的 exe、Linux 的命令绝对路径；文件管理器为空串。 */
  location: string
}

const mac = (name: string): string[] => [
  `/Applications/${name}.app`,
  join(homedir(), "Applications", `${name}.app`),
]

const MAC_APPS: OpenAppDef[] = [
  {
    id: "finder",
    name: "Finder",
    kind: "file-manager",
    bundles: ["/System/Library/CoreServices/Finder.app"],
  },
  { id: "vscode", name: "VS Code", kind: "editor", bundles: mac("Visual Studio Code") },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    kind: "editor",
    bundles: mac("Visual Studio Code - Insiders"),
  },
  { id: "cursor", name: "Cursor", kind: "editor", bundles: mac("Cursor") },
  { id: "windsurf", name: "Windsurf", kind: "editor", bundles: mac("Windsurf") },
  { id: "trae", name: "Trae", kind: "editor", bundles: [...mac("Trae"), ...mac("Trae CN")] },
  { id: "zed", name: "Zed", kind: "editor", bundles: mac("Zed") },
  { id: "codebuddy", name: "CodeBuddy", kind: "editor", bundles: mac("CodeBuddy") },
  { id: "qoder", name: "Qoder", kind: "editor", bundles: mac("Qoder") },
  { id: "kiro", name: "Kiro", kind: "editor", bundles: mac("Kiro") },
  { id: "sublime", name: "Sublime Text", kind: "editor", bundles: mac("Sublime Text") },
  { id: "xcode", name: "Xcode", kind: "editor", bundles: mac("Xcode") },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    kind: "editor",
    bundles: [...mac("IntelliJ IDEA"), ...mac("IntelliJ IDEA CE")],
  },
  { id: "webstorm", name: "WebStorm", kind: "editor", bundles: mac("WebStorm") },
  {
    id: "pycharm",
    name: "PyCharm",
    kind: "editor",
    bundles: [...mac("PyCharm"), ...mac("PyCharm CE")],
  },
  { id: "goland", name: "GoLand", kind: "editor", bundles: mac("GoLand") },
  {
    id: "terminal",
    name: "Terminal",
    kind: "terminal",
    bundles: ["/System/Applications/Utilities/Terminal.app"],
  },
  { id: "iterm", name: "iTerm", kind: "terminal", bundles: mac("iTerm") },
  { id: "ghostty", name: "Ghostty", kind: "terminal", bundles: mac("Ghostty") },
  { id: "warp", name: "Warp", kind: "terminal", bundles: mac("Warp") },
  { id: "wezterm", name: "WezTerm", kind: "terminal", bundles: mac("WezTerm") },
]

/** Windows 的常见安装位置：用户级 Programs 与 Program Files。 */
function windowsCandidates(...segments: string[]): string[] {
  const drive = process.env.SystemDrive ?? "C:"
  const local =
    process.env.LOCALAPPDATA ?? win32.join(drive, "Users", "Default", "AppData", "Local")
  return [
    win32.join(local, "Programs", ...segments),
    ...[
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      win32.join(drive, "Program Files"),
    ]
      .filter((root): root is string => Boolean(root))
      .map((root) => win32.join(root, ...segments)),
  ]
}

/** JetBrains 的安装目录带版本号，按目录名前缀找最新的一个。 */
function jetbrains(prefix: string, exe: string): string[] {
  const roots = windowsCandidates("JetBrains")
  const found: string[] = []
  for (const root of roots) {
    try {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort()
        .reverse()
      found.push(...dirs.map((dir) => win32.join(root, dir, "bin", exe)))
    } catch {
      // 没装 JetBrains 时目录不存在。
    }
  }
  return found
}

function windowsApps(): OpenAppDef[] {
  const windir = process.env.WINDIR ?? "C:\\Windows"
  const local = process.env.LOCALAPPDATA ?? ""
  return [
    {
      id: "explorer",
      name: "File Explorer",
      kind: "file-manager",
      executables: [win32.join(windir, "explorer.exe")],
    },
    {
      id: "vscode",
      name: "VS Code",
      kind: "editor",
      executables: windowsCandidates("Microsoft VS Code", "Code.exe"),
    },
    {
      id: "vscode-insiders",
      name: "VS Code Insiders",
      kind: "editor",
      executables: windowsCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "editor",
      executables: windowsCandidates("cursor", "Cursor.exe"),
    },
    {
      id: "windsurf",
      name: "Windsurf",
      kind: "editor",
      executables: windowsCandidates("Windsurf", "Windsurf.exe"),
    },
    {
      id: "trae",
      name: "Trae",
      kind: "editor",
      executables: [
        ...windowsCandidates("Trae", "Trae.exe"),
        ...windowsCandidates("Trae CN", "Trae CN.exe"),
      ],
    },
    { id: "zed", name: "Zed", kind: "editor", executables: windowsCandidates("Zed", "Zed.exe") },
    {
      id: "codebuddy",
      name: "CodeBuddy",
      kind: "editor",
      executables: windowsCandidates("CodeBuddy", "CodeBuddy.exe"),
    },
    {
      id: "idea",
      name: "IntelliJ IDEA",
      kind: "editor",
      executables: jetbrains("IntelliJ IDEA", "idea64.exe"),
    },
    {
      id: "webstorm",
      name: "WebStorm",
      kind: "editor",
      executables: jetbrains("WebStorm", "webstorm64.exe"),
    },
    {
      id: "pycharm",
      name: "PyCharm",
      kind: "editor",
      executables: jetbrains("PyCharm", "pycharm64.exe"),
    },
    {
      id: "windows-terminal",
      name: "Windows Terminal",
      kind: "terminal",
      executables: [win32.join(local, "Microsoft", "WindowsApps", "wt.exe")],
      args: (folder) => ["-d", folder],
    },
    {
      id: "powershell",
      name: "PowerShell",
      kind: "terminal",
      executables: [win32.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")],
      args: (folder) => [
        "-NoExit",
        "-Command",
        `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'`,
      ],
    },
  ]
}

const LINUX_APPS: OpenAppDef[] = [
  {
    id: "file-manager",
    name: "Files",
    kind: "file-manager",
    desktopIds: ["org.gnome.Nautilus", "org.kde.dolphin", "thunar", "nemo", "pcmanfm", "caja"],
  },
  {
    id: "vscode",
    name: "VS Code",
    kind: "editor",
    commands: ["code"],
    desktopIds: ["code", "visual-studio-code", "com.visualstudio.code"],
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    kind: "editor",
    commands: ["code-insiders"],
    desktopIds: ["code-insiders"],
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    commands: ["cursor"],
    desktopIds: ["cursor", "co.anysphere.cursor"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    kind: "editor",
    commands: ["windsurf"],
    desktopIds: ["windsurf"],
  },
  {
    id: "zed",
    name: "Zed",
    kind: "editor",
    commands: ["zed", "zeditor"],
    desktopIds: ["dev.zed.Zed", "zed"],
  },
  {
    id: "sublime",
    name: "Sublime Text",
    kind: "editor",
    commands: ["subl"],
    desktopIds: ["sublime_text", "sublime-text"],
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    kind: "editor",
    commands: ["idea", "intellij-idea-ultimate", "intellij-idea-community"],
    desktopIds: ["jetbrains-idea", "jetbrains-idea-ce"],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    kind: "editor",
    commands: ["webstorm"],
    desktopIds: ["jetbrains-webstorm"],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    kind: "editor",
    commands: ["pycharm", "pycharm-community"],
    desktopIds: ["jetbrains-pycharm", "jetbrains-pycharm-ce"],
  },
  {
    id: "gnome-terminal",
    name: "Terminal",
    kind: "terminal",
    commands: ["gnome-terminal"],
    args: (folder) => [`--working-directory=${folder}`],
    desktopIds: ["org.gnome.Terminal"],
  },
  {
    id: "konsole",
    name: "Konsole",
    kind: "terminal",
    commands: ["konsole"],
    args: (folder) => ["--workdir", folder],
    desktopIds: ["org.kde.konsole"],
  },
  {
    id: "ghostty",
    name: "Ghostty",
    kind: "terminal",
    commands: ["ghostty"],
    args: (folder) => [`--working-directory=${folder}`],
    desktopIds: ["com.mitchellh.ghostty"],
  },
  {
    id: "kitty",
    name: "kitty",
    kind: "terminal",
    commands: ["kitty"],
    args: (folder) => ["--directory", folder],
    desktopIds: ["kitty"],
  },
  {
    id: "alacritty",
    name: "Alacritty",
    kind: "terminal",
    commands: ["alacritty"],
    args: (folder) => ["--working-directory", folder],
    desktopIds: ["Alacritty", "org.alacritty.Alacritty"],
  },
  {
    id: "wezterm",
    name: "WezTerm",
    kind: "terminal",
    commands: ["wezterm"],
    args: (folder) => ["start", "--cwd", folder],
    desktopIds: ["org.wezfurlong.wezterm"],
  },
  {
    id: "xfce4-terminal",
    name: "Xfce Terminal",
    kind: "terminal",
    commands: ["xfce4-terminal"],
    args: (folder) => [`--working-directory=${folder}`],
    desktopIds: ["xfce4-terminal"],
  },
]

/** 当前平台的候选应用。 */
export function appDefsFor(platform: NodeJS.Platform = process.platform): OpenAppDef[] {
  if (platform === "darwin") return MAC_APPS
  if (platform === "win32") return windowsApps()
  return LINUX_APPS
}

/** 在 PATH 上找命令的绝对路径。 */
export function findOnPath(
  command: string,
  searchPath = process.env.PATH ?? "",
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (exists(candidate)) return candidate
  }
  return null
}

/** 检测本机装了哪些应用；文件管理器总是可用。顺序与定义一致。 */
export function detectApps(
  defs: readonly OpenAppDef[],
  exists: (path: string) => boolean = existsSync,
  searchPath = process.env.PATH ?? "",
): DetectedApp[] {
  const detected: DetectedApp[] = []
  for (const def of defs) {
    if (def.kind === "file-manager" && !def.bundles && !def.executables) {
      detected.push({ def, location: "" })
      continue
    }
    const location =
      def.bundles?.find((path) => exists(path)) ??
      def.executables?.find((path) => exists(path)) ??
      def.commands?.map((command) => findOnPath(command, searchPath, exists)).find(Boolean) ??
      null
    if (location) detected.push({ def, location })
  }
  return detected
}

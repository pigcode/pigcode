/** 文件树与标签里的文件图标：按文件名与扩展名选图标和颜色，目录区分展开与收起。 */
import {
  File,
  FileArchive,
  FileAudio,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderGit2,
  FolderOpen,
  type LucideIcon,
} from "lucide-react"

/** 图标与色调；色调对应样式里的 `file-tone-*`。 */
interface FileVisual {
  icon: LucideIcon
  tone: string
}

const BY_NAME: Record<string, FileVisual> = {
  "package.json": { icon: FileBraces, tone: "npm" },
  "package-lock.json": { icon: FileLock, tone: "lock" },
  "pnpm-lock.yaml": { icon: FileLock, tone: "lock" },
  "yarn.lock": { icon: FileLock, tone: "lock" },
  "bun.lock": { icon: FileLock, tone: "lock" },
  "cargo.lock": { icon: FileLock, tone: "lock" },
  dockerfile: { icon: FileCog, tone: "config" },
  makefile: { icon: FileTerminal, tone: "shell" },
  license: { icon: FileText, tone: "doc" },
  ".gitignore": { icon: FileCog, tone: "git" },
  ".gitattributes": { icon: FileCog, tone: "git" },
  ".editorconfig": { icon: FileCog, tone: "config" },
  ".env": { icon: FileLock, tone: "env" },
  "agents.md": { icon: FileText, tone: "agent" },
  "claude.md": { icon: FileText, tone: "agent" },
}

const CODE = (tone: string): FileVisual => ({ icon: FileCode, tone })

const BY_EXTENSION: Record<string, FileVisual> = {
  ts: CODE("ts"),
  mts: CODE("ts"),
  cts: CODE("ts"),
  tsx: CODE("react"),
  jsx: CODE("react"),
  js: CODE("js"),
  mjs: CODE("js"),
  cjs: CODE("js"),
  vue: CODE("vue"),
  svelte: CODE("svelte"),
  astro: CODE("svelte"),
  py: CODE("py"),
  rs: CODE("rs"),
  go: CODE("go"),
  java: CODE("java"),
  kt: CODE("java"),
  swift: CODE("swift"),
  c: CODE("c"),
  h: CODE("c"),
  cpp: CODE("c"),
  hpp: CODE("c"),
  cs: CODE("cs"),
  rb: CODE("rb"),
  php: CODE("php"),
  lua: CODE("lua"),
  dart: CODE("dart"),
  html: CODE("html"),
  htm: CODE("html"),
  css: CODE("css"),
  scss: CODE("css"),
  less: CODE("css"),
  sql: CODE("data"),
  graphql: CODE("data"),
  json: { icon: FileBraces, tone: "json" },
  jsonc: { icon: FileBraces, tone: "json" },
  json5: { icon: FileBraces, tone: "json" },
  yaml: { icon: FileCog, tone: "config" },
  yml: { icon: FileCog, tone: "config" },
  toml: { icon: FileCog, tone: "config" },
  ini: { icon: FileCog, tone: "config" },
  xml: CODE("html"),
  md: { icon: FileText, tone: "doc" },
  mdx: { icon: FileText, tone: "doc" },
  txt: { icon: FileText, tone: "plain" },
  rst: { icon: FileText, tone: "doc" },
  sh: { icon: FileTerminal, tone: "shell" },
  bash: { icon: FileTerminal, tone: "shell" },
  zsh: { icon: FileTerminal, tone: "shell" },
  ps1: { icon: FileTerminal, tone: "shell" },
  png: { icon: FileImage, tone: "image" },
  jpg: { icon: FileImage, tone: "image" },
  jpeg: { icon: FileImage, tone: "image" },
  gif: { icon: FileImage, tone: "image" },
  webp: { icon: FileImage, tone: "image" },
  svg: { icon: FileImage, tone: "image" },
  ico: { icon: FileImage, tone: "image" },
  avif: { icon: FileImage, tone: "image" },
  mp4: { icon: FileVideo, tone: "media" },
  mov: { icon: FileVideo, tone: "media" },
  webm: { icon: FileVideo, tone: "media" },
  mp3: { icon: FileAudio, tone: "media" },
  wav: { icon: FileAudio, tone: "media" },
  csv: { icon: FileSpreadsheet, tone: "data" },
  tsv: { icon: FileSpreadsheet, tone: "data" },
  zip: { icon: FileArchive, tone: "archive" },
  gz: { icon: FileArchive, tone: "archive" },
  tgz: { icon: FileArchive, tone: "archive" },
  tar: { icon: FileArchive, tone: "archive" },
  woff: { icon: FileType, tone: "plain" },
  woff2: { icon: FileType, tone: "plain" },
  ttf: { icon: FileType, tone: "plain" },
  lock: { icon: FileLock, tone: "lock" },
}

/** 文件的图标与色调。 */
export function fileVisual(name: string): FileVisual {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower] ?? (lower.startsWith(".env.") ? BY_NAME[".env"] : undefined)
  if (byName) return byName
  if (lower.startsWith("dockerfile")) return { icon: FileCog, tone: "config" }
  const dot = lower.lastIndexOf(".")
  return (dot > 0 ? BY_EXTENSION[lower.slice(dot + 1)] : undefined) ?? { icon: File, tone: "plain" }
}

/** 文件或目录的图标。 */
export function FileIcon({
  name,
  kind,
  open = false,
}: {
  name: string
  kind: "file" | "directory"
  open?: boolean
}) {
  if (kind === "directory") {
    const Icon = name === ".github" || name === ".git" ? FolderGit2 : open ? FolderOpen : Folder
    return <Icon className="ic ic-sm file-icon file-tone-folder" aria-hidden="true" />
  }
  const { icon: Icon, tone } = fileVisual(name)
  return <Icon className={`ic ic-sm file-icon file-tone-${tone}`} aria-hidden="true" />
}

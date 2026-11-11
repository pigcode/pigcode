/**
 * 右侧面板的文件 surface：文件树标签与单个文件标签（带可收起的文件树侧栏）。
 * 目录、搜索、读写都经 Host 的 workspace RPC；右键菜单用系统原生菜单。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import { copyText, useLocale } from "@pigcode/ui-primitives"
import { requestComposerMention } from "@pigcode/ui-composer"
import {
  FileExplorer,
  FileViewer,
  gitDecorations,
  type ExplorerListing,
  type ExplorerSearchResult,
  type FileViewerFile,
} from "@pigcode/ui-workbench"
import { getDraft, setDraft, useDraftVersion } from "./file-drafts"
import type { Translate } from "./workbench-labels"
import type { WorkspaceScope } from "./workspace-scope"

/** 两种文件 surface 共用的属性。 */
interface FilesBaseProps {
  connection: Connection
  /** 会话，或者新会话草稿的项目。 */
  scope: WorkspaceScope
  /**
   * 未保存的修改与文件树的展开状态按它记：右侧面板的 key，草稿建成会话后不变，
   * 草稿里改了一半的文件跟着到会话里。
   */
  draftKey: string
  /** 项目名，显示为文件树与面包屑的根。 */
  rootName: string
  /** agent 改过文件、保存或恢复检查点后递增，重新读取目录与文件。 */
  revision: number
  onOpenFile: (path: string) => void
  onError: (message: string) => void
  /** 保存成功后调用；文件树与 git 标记随之刷新。 */
  onSaved?: (() => void) | undefined
}

/** 能预览的图片按 base64 读取；SVG 也按图片显示。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"])

function isImage(path: string): boolean {
  return IMAGE_EXTENSIONS.has(path.split(".").at(-1)?.toLowerCase() ?? "")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 工作目录的绝对路径；切换 worktree 后会变，每次用到时现取。 */
async function workspaceRoot(connection: Connection, scope: WorkspaceScope): Promise<string> {
  return ((await connection.call("workspace.root", scope)) as { root: string }).root
}

/** 拼出绝对路径；Windows 的根目录用反斜杠。 */
function absolutePath(root: string, path: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  return path
    ? `${root.replace(/[\\/]+$/, "")}${separator}${path.split("/").join(separator)}`
    : root
}

/** 目录读取与路径搜索；回调保持稳定，资源管理器据此决定何时重读。 */
function useWorkspaceApi(connection: Connection, scope: WorkspaceScope) {
  const loadDirectory = useCallback(
    (path: string) =>
      connection.call("workspace.list", { ...scope, path }) as Promise<ExplorerListing>,
    [connection, scope],
  )
  const searchPaths = useCallback(
    (query: string) =>
      connection.call("workspace.searchPaths", {
        ...scope,
        query,
      }) as Promise<ExplorerSearchResult>,
    [connection, scope],
  )
  return { loadDirectory, searchPaths }
}

/** 工作区的 git 改动；不是 git 仓库时为 null。 */
function useGitDecorations(connection: Connection, scope: WorkspaceScope, revision: number) {
  const [changes, setChanges] = useState<Array<{ path: string; status: string }> | null>(null)
  useEffect(() => {
    let cancelled = false
    void (
      connection.call("git.status", scope) as Promise<{
        changed: Array<{ path: string; status: string }>
      }>
    )
      .then((status) => {
        if (!cancelled) setChanges(status.changed)
      })
      .catch(() => {
        if (!cancelled) setChanges(null)
      })
    return () => {
      cancelled = true
    }
  }, [connection, scope, revision])
  return useMemo(() => (changes ? gitDecorations(changes) : null), [changes])
}

/** 文件或目录的右键菜单：打开、添加到对话、复制路径、在文件管理器中显示。 */
async function showEntryMenu(options: {
  connection: Connection
  scope: WorkspaceScope
  entry: { path: string; kind: "file" | "directory" }
  point: { x: number; y: number }
  t: Translate
  onOpenFile: (path: string) => void
  onError: (message: string) => void
}): Promise<void> {
  const { entry, t } = options
  const popup = window.pigcodeNative?.popupMenu
  if (!popup) return
  const items = [
    ...(entry.kind === "file" ? [{ id: "open", label: t("files.menu.open") }] : []),
    { id: "mention", label: t("files.menu.mention") },
    { type: "separator" as const },
    { id: "copy-path", label: t("files.menu.copyPath") },
    { id: "copy-relative", label: t("files.menu.copyRelativePath") },
    ...(window.pigcodeNative?.revealPath
      ? [{ type: "separator" as const }, { id: "reveal", label: t("files.menu.reveal") }]
      : []),
  ]
  const choice = await popup(items, options.point)
  try {
    if (choice === "open") options.onOpenFile(entry.path)
    else if (choice === "mention") requestComposerMention(entry.path)
    else if (choice === "copy-relative") await copyText(entry.path)
    else if (choice === "copy-path" || choice === "reveal") {
      const path = absolutePath(await workspaceRoot(options.connection, options.scope), entry.path)
      if (choice === "copy-path") await copyText(path)
      else await window.pigcodeNative?.revealPath?.(path)
    }
  } catch (error) {
    options.onError(messageOf(error))
  }
}

/** 文件树标签：占满整个面板的资源管理器。 */
export function FilesSurface({
  connection,
  scope,
  draftKey,
  rootName,
  revision,
  onOpenFile,
  onError,
}: FilesBaseProps) {
  const { t } = useLocale()
  const api = useWorkspaceApi(connection, scope)
  const git = useGitDecorations(connection, scope, revision)
  return (
    <div className="files-surface">
      <FileExplorer
        rootName={rootName}
        loadDirectory={api.loadDirectory}
        searchPaths={api.searchPaths}
        onOpenFile={onOpenFile}
        revision={revision}
        git={git}
        stateKey={`explorer:${draftKey}`}
        onContextMenu={(entry, point) =>
          void showEntryMenu({ connection, scope, entry, point, t, onOpenFile, onError })
        }
      />
    </div>
  )
}

const EXPLORER_OPEN_KEY = "pigcode.files.explorerOpen"
/** 文件标签比这窄时，文件树不占位置，改成盖在编辑器上的抽屉。 */
const DOCK_MIN_WIDTH = 560

/**
 * 文件树侧栏：够宽时停靠在左侧，是否展开本机记住；窄的时候默认收起，打开后盖在编辑器上，
 * 选了文件就收起，编辑器不会被挤成一条。
 */
function useExplorerAside(): {
  ref: (element: HTMLDivElement | null) => void
  docked: boolean
  open: boolean
  toggle: () => void
  close: () => void
} {
  const [preferred, setPreferred] = useState(
    () => window.localStorage.getItem(EXPLORER_OPEN_KEY) !== "false",
  )
  const [overlay, setOverlay] = useState(false)
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!element || typeof ResizeObserver === "undefined") return
    observer.current = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.current.observe(element)
    setWidth(element.clientWidth)
  }, [])
  const docked = width >= DOCK_MIN_WIDTH
  return {
    ref,
    docked,
    open: docked ? preferred : overlay,
    toggle: () => {
      if (!docked) {
        setOverlay((current) => !current)
        return
      }
      setPreferred((current) => {
        window.localStorage.setItem(EXPLORER_OPEN_KEY, String(!current))
        return !current
      })
    },
    close: () => setOverlay(false),
  }
}

/** 单个文件标签的属性。 */
export interface FileSurfaceProps extends FilesBaseProps {
  path: string
  line?: number | undefined
}

/** 文件标签：读取、编辑与保存一个文件，左侧可以展开文件树。 */
export function FileSurface({
  connection,
  scope,
  draftKey,
  rootName,
  revision,
  onOpenFile,
  onError,
  onSaved,
  path,
  line,
}: FileSurfaceProps) {
  const { t } = useLocale()
  const api = useWorkspaceApi(connection, scope)
  const git = useGitDecorations(connection, scope, revision)
  const aside = useExplorerAside()
  const [file, setFile] = useState<FileViewerFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [focusDirectory, setFocusDirectory] = useState<string | null>(null)
  const fileRef = useRef(file)
  fileRef.current = file
  useDraftVersion()
  const draft = getDraft(draftKey, path)

  const read = useCallback(
    () =>
      connection.call("workspace.readFile", {
        ...scope,
        path,
        ...(isImage(path) ? { encoding: "image" } : {}),
      }) as Promise<FileViewerFile>,
    [connection, scope, path],
  )

  // 打开时读取；revision 变化时，没有草稿就静默重读，有草稿只检查磁盘上的文件是否变了。
  useEffect(() => {
    let cancelled = false
    setError(null)
    void read()
      .then((next) => {
        if (cancelled) return
        const current = fileRef.current
        if (getDraft(draftKey, path) !== null && current) {
          if (next.mtimeMs !== current.mtimeMs) setConflict(true)
          return
        }
        setFile(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [read, revision, draftKey, path])

  async function save(force = false): Promise<void> {
    const text = getDraft(draftKey, path)
    if (text === null || !file) return
    setSaving(true)
    try {
      const saved = (await connection.call("workspace.writeFile", {
        ...scope,
        path,
        text,
        eol: file.eol,
        ...(force ? {} : { expectedMtimeMs: file.mtimeMs }),
      })) as { size: number; mtimeMs: number }
      setFile({ ...file, text, size: saved.size, mtimeMs: saved.mtimeMs })
      setDraft(draftKey, path, null)
      setConflict(false)
      onSaved?.()
    } catch (reason) {
      const message = messageOf(reason)
      if (message.includes("FILE_CHANGED")) setConflict(true)
      else onError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={aside.ref}
      className="file-surface"
      data-explorer={aside.open || undefined}
      data-overlay={(aside.open && !aside.docked) || undefined}
    >
      {aside.open ? (
        <aside className="file-surface-aside">
          <FileExplorer
            compact
            rootName={rootName}
            loadDirectory={api.loadDirectory}
            searchPaths={api.searchPaths}
            onOpenFile={(target) => {
              setFocusDirectory(null)
              aside.close()
              onOpenFile(target)
            }}
            activePath={focusDirectory ?? path}
            activeKind={focusDirectory !== null ? "directory" : "file"}
            revision={revision}
            git={git}
            stateKey={`explorer:${draftKey}`}
            onContextMenu={(entry, point) =>
              void showEntryMenu({ connection, scope, entry, point, t, onOpenFile, onError })
            }
          />
        </aside>
      ) : null}
      <FileViewer
        path={path}
        rootName={rootName}
        file={file}
        loading={loading}
        error={error}
        draft={draft}
        onDraftChange={(text) => setDraft(draftKey, path, text)}
        onSave={() => void save()}
        saving={saving}
        conflict={conflict}
        onReload={() => {
          setDraft(draftKey, path, null)
          setConflict(false)
          setLoading(true)
          void read()
            .then(setFile)
            .catch((reason: unknown) => setError(messageOf(reason)))
            .finally(() => setLoading(false))
        }}
        onOverwrite={() => void save(true)}
        explorerOpen={aside.open}
        onToggleExplorer={aside.toggle}
        onNavigate={(directory) => {
          if (!aside.open) aside.toggle()
          setFocusDirectory(directory)
        }}
        onMore={(point) =>
          void showEntryMenu({
            connection,
            scope,
            entry: { path, kind: "file" },
            point,
            t,
            onOpenFile,
            onError,
          })
        }
        revealLine={line ?? null}
      />
    </div>
  )
}

/** 文件标签共用一套导航、工具栏和预览区域。 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { Connection } from "@pigcode/client-runtime"
import { requestComposerMention } from "@pigcode/ui-composer"
import { useLocale } from "@pigcode/ui-primitives"
import { OpenInButton, Resizer } from "@pigcode/ui-shell"
import {
  FileExplorer,
  FileViewer,
  gitDecorations,
  type ExplorerListing,
  type ExplorerSearchResult,
} from "@pigcode/ui-workbench"
import { absoluteFilePath, showFileMenu, type FileMenuEntry } from "./file-actions"
import { useFileDocument } from "./use-file-document"
import { useFileNavigation } from "./use-file-navigation"
import type { WorkspaceScope } from "./workspace-scope"

const Markdown = lazy(() =>
  import("@pigcode/ui-chat").then((module) => ({ default: module.Markdown })),
)

/** 文件导航和当前文件所需的工作区信息。 */
export interface FilesSurfaceProps {
  connection: Connection
  scope: WorkspaceScope
  draftKey: string
  rootName: string
  revision: number
  onOpenFile: (path: string) => void
  onOpenFileTab: (path: string) => void
  onError: (message: string) => void
  onSaved: () => void
  onEdit?: (() => void) | undefined
  navigationFooter?: ReactNode
  path?: string | undefined
  line?: number | undefined
}

/** 渲染文件导航和当前文件；还没打开文件时在右侧显示空状态。 */
export function FilesSurface({
  connection,
  scope,
  draftKey,
  rootName,
  revision,
  onOpenFile,
  onOpenFileTab,
  onError,
  onSaved,
  onEdit,
  navigationFooter,
  path,
  line,
}: FilesSurfaceProps) {
  const { t } = useLocale()
  const aside = useFileNavigation(Boolean(path))
  const [focusDirectory, setFocusDirectory] = useState<{
    path: string | undefined
    directory: string
  } | null>(null)
  const [rootState, setRootState] = useState<{
    scope: WorkspaceScope
    root: string | null
    revision: number
  } | null>(null)
  const [changes, setChanges] = useState<Array<{ path: string; status: string }> | null>(null)
  const root = rootState?.scope === scope && rootState.revision === revision ? rootState.root : null
  const openWorkspaceFile = window.pigcodeNative?.openWorkspaceFile
  const [refreshCount, setRefreshCount] = useState(0)
  const indexedWorkspace = useRef<{ scope: WorkspaceScope; revision: number } | null>(null)
  const [markdownMode, setMarkdownMode] = useState<{
    path: string
    mode: "preview" | "source"
  } | null>(null)
  const currentRevision = revision + refreshCount
  const file = useFileDocument({
    connection,
    scope,
    draftKey,
    path,
    revision: currentRevision,
    onSaved,
    onError,
  })

  useEffect(() => {
    let cancelled = false
    void (connection.call("workspace.root", scope) as Promise<{ root: string }>)
      .then(({ root }) => {
        if (!cancelled) setRootState({ scope, root, revision })
      })
      .catch(() => {
        if (!cancelled) setRootState({ scope, root: null, revision })
      })
    return () => {
      cancelled = true
    }
  }, [connection, scope, revision])

  useEffect(() => {
    let cancelled = false
    void (
      connection.call("git.status", scope) as Promise<{
        changed: Array<{ path: string; status: string }>
      }>
    )
      .then(({ changed }) => {
        if (!cancelled) setChanges(changed)
      })
      .catch(() => {
        if (!cancelled) setChanges(null)
      })
    return () => {
      cancelled = true
    }
  }, [connection, scope, currentRevision])

  const git = useMemo(() => (changes ? gitDecorations(changes) : null), [changes])
  const loadDirectory = useCallback(
    (target: string) =>
      connection.call("workspace.list", { ...scope, path: target }) as Promise<ExplorerListing>,
    [connection, scope],
  )
  const searchPaths = useCallback(
    (query: string) => {
      const previous = indexedWorkspace.current
      const refresh = previous?.scope !== scope || previous.revision !== currentRevision
      indexedWorkspace.current = { scope, revision: currentRevision }
      return connection.call("workspace.searchPaths", {
        ...scope,
        query,
        ...(refresh ? { refresh } : {}),
      }) as Promise<ExplorerSearchResult>
    },
    [connection, scope, currentRevision],
  )

  const directory = focusDirectory?.path === path ? focusDirectory?.directory : undefined
  const canPreviewMarkdown =
    path !== undefined && /\.(md|markdown)$/i.test(path) && file.file !== null && !file.file.binary
  const preferredMode = markdownMode?.path === path ? markdownMode?.mode : undefined
  const open = (target: string, separate: boolean) => {
    setFocusDirectory(null)
    aside.selectFile()
    if (separate) onOpenFileTab(target)
    else onOpenFile(target)
  }
  const showMenu = (entry: FileMenuEntry, point: { x: number; y: number }) =>
    void showFileMenu({
      root,
      entry,
      point,
      t,
      onOpenFile: (target) => open(target, false),
      onOpenFileTab: (target) => open(target, true),
      onMention: requestComposerMention,
    }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))

  return (
    <div
      ref={aside.ref}
      className="files-surface"
      data-navigation-only={(aside.open && !aside.docked) || undefined}
    >
      <FileViewer
        {...file}
        onDraftChange={(text) => {
          file.onDraftChange(text)
          if (text !== null && file.draft === null) onEdit?.()
        }}
        path={path ?? null}
        rootName={rootName}
        revealLine={line ?? null}
        explorerOpen={aside.open}
        onToggleExplorer={() => aside.show(!aside.open)}
        onNavigate={(target) => {
          aside.show(true)
          setFocusDirectory({ path, directory: target })
        }}
        onMore={path ? (point) => showMenu({ path, kind: "file" }, point) : undefined}
        openIn={
          root && path && openWorkspaceFile ? (
            <OpenInButton
              path={absoluteFilePath(root, path)}
              openFile={(appId) => openWorkspaceFile(root, path, appId)}
            />
          ) : null
        }
        previewMode={preferredMode ?? (line || file.draft !== null ? "source" : "preview")}
        onPreviewModeChange={
          canPreviewMarkdown && path ? (mode) => setMarkdownMode({ path, mode }) : undefined
        }
        preview={
          canPreviewMarkdown ? (
            <article className="file-markdown-preview md">
              <Suspense fallback={null}>
                <Markdown text={file.draft ?? file.file?.text ?? ""} />
              </Suspense>
            </article>
          ) : undefined
        }
        navigationOnly={aside.open && !aside.docked}
        navigation={
          aside.open ? (
            <aside
              className="file-surface-aside"
              style={aside.docked ? { width: aside.width } : undefined}
            >
              <FileExplorer
                compact
                rootName={rootName}
                loadDirectory={loadDirectory}
                searchPaths={searchPaths}
                onOpenFile={(target) => open(target, false)}
                onOpenFileTab={(target) => open(target, true)}
                activePath={directory ?? path ?? null}
                activeKind={directory === undefined ? "file" : "directory"}
                revision={currentRevision}
                git={git}
                stateKey={`explorer:${draftKey}`}
                onRefresh={() => setRefreshCount((count) => count + 1)}
                onRootMenu={(point) => showMenu({ path: "", kind: "directory" }, point)}
                onContextMenu={showMenu}
              />
              {navigationFooter}
              {aside.docked ? (
                <Resizer
                  panel={aside.resizer}
                  edge="right"
                  className="panel-resizer file-navigation-resizer"
                  label={t("files.resizeNavigation")}
                  width={aside.width}
                  onChange={aside.resize}
                />
              ) : null}
            </aside>
          ) : null
        }
      />
    </div>
  )
}

/** 读取与保存当前文件；切换预览时忽略上一个文件尚未返回的结果。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { FileViewerFile } from "@pigcode/ui-workbench"
import { getDraft, setDraft, useDraftVersion } from "./file-drafts"
import type { WorkspaceScope } from "./workspace-scope"

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface DocumentState {
  scope: WorkspaceScope
  file: FileViewerFile | null
  error: string | null
  conflict: boolean
}

/** 文件预览使用的读写状态；草稿跨标签切换保留。 */
export function useFileDocument({
  connection,
  scope,
  draftKey,
  path,
  revision,
  onSaved,
  onError,
}: {
  connection: Connection
  scope: WorkspaceScope
  draftKey: string
  path: string | undefined
  revision: number
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [documents, setDocuments] = useState<Map<string, DocumentState>>(() => new Map())
  const document = path ? documents.get(path) : undefined
  const current = document?.scope === scope ? document : null
  const file = current?.file ?? null
  const [savingPaths, setSavingPaths] = useState<ReadonlySet<string>>(new Set())
  const writing = useRef(new Set<string>())
  const readEpoch = useRef(new Map<string, number>())
  const [reload, setReload] = useState(0)
  useDraftVersion()
  const draft = path ? getDraft(draftKey, path) : null

  const read = useCallback(
    (target: string) =>
      connection.call("workspace.readFile", {
        ...scope,
        path: target,
        ...(IMAGE_EXTENSIONS.has(target.split(".").at(-1)?.toLowerCase() ?? "")
          ? { encoding: "image" }
          : {}),
      }) as Promise<FileViewerFile>,
    [connection, scope],
  )

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const target = path
    const epoch = readEpoch.current.get(target)
    void read(target)
      .then((next) => {
        if (cancelled || epoch !== readEpoch.current.get(target)) return
        setDocuments((all) => {
          const previous = all.get(target)
          const prior = previous?.scope === scope ? previous.file : null
          const dirty = getDraft(draftKey, target) !== null
          // 只缓存当前文件和有草稿的文件，避免浏览大目录时留住已替换的图片和文本。
          const nextDocuments = new Map(
            [...all].filter(
              ([filePath]) => filePath === target || getDraft(draftKey, filePath) !== null,
            ),
          )
          return nextDocuments.set(target, {
            scope,
            file: dirty && prior ? prior : next,
            conflict: dirty && prior !== null && next.mtimeMs !== prior.mtimeMs,
            error: null,
          })
        })
      })
      .catch((reason: unknown) => {
        if (!cancelled && epoch === readEpoch.current.get(target))
          setDocuments((all) =>
            new Map(all).set(target, {
              scope,
              file: null,
              conflict: false,
              error: messageOf(reason),
            }),
          )
      })
    return () => {
      cancelled = true
    }
  }, [read, path, scope, revision, draftKey, reload])

  async function save(force = false): Promise<void> {
    if (!path || !file || writing.current.has(path)) return
    const text = getDraft(draftKey, path)
    if (text === null) return
    writing.current.add(path)
    readEpoch.current.set(path, (readEpoch.current.get(path) ?? 0) + 1)
    setSavingPaths(new Set(writing.current))
    try {
      const saved = (await connection.call("workspace.writeFile", {
        ...scope,
        path,
        text,
        eol: file.eol,
        ...(force ? {} : { expectedMtimeMs: file.mtimeMs }),
      })) as { size: number; mtimeMs: number }
      setDocuments((all) => {
        if (all.get(path)?.scope !== scope) return all
        return new Map(all).set(path, {
          scope,
          error: null,
          conflict: false,
          file: { ...file, text, size: saved.size, mtimeMs: saved.mtimeMs },
        })
      })
      if (getDraft(draftKey, path) === text) setDraft(draftKey, path, null)
      onSaved()
    } catch (reason) {
      const message = messageOf(reason)
      if (message.includes("FILE_CHANGED")) {
        setDocuments((all) => {
          const previous = all.get(path)
          return previous?.scope === scope
            ? new Map(all).set(path, { ...previous, conflict: true })
            : all
        })
      } else onError(message)
    } finally {
      writing.current.delete(path)
      setSavingPaths(new Set(writing.current))
    }
  }

  return {
    file,
    loading: Boolean(path && !current),
    error: current?.error ?? null,
    draft,
    onDraftChange: (text: string | null) => {
      if (path) setDraft(draftKey, path, text)
    },
    saving: path !== undefined && savingPaths.has(path),
    conflict: current?.conflict ?? false,
    onSave: () => void save(),
    onOverwrite: () => void save(true),
    onReload: () => {
      if (!path) return
      setDraft(draftKey, path, null)
      setDocuments((all) => {
        const next = new Map(all)
        next.delete(path)
        return next
      })
      setReload((value) => value + 1)
    },
  }
}

/**
 * 文件标签的内容：顶部面包屑与操作，下面是可编辑的高亮代码、图片预览或无法预览的说明。
 * 修改只在保存时写回磁盘；文件在编辑期间被别处改过时给出提示，由用户选择重新加载或覆盖。
 */
import { ChevronRight, Ellipsis, PanelLeftClose, PanelLeftOpen, Save } from "lucide-react"
import { useState } from "react"
import { CodeEditor } from "./code-editor"
import { languageForPath } from "@pigcode/ui-primitives"

/** 一次读取的文件；字段与 Host 的 workspace.readFile 一致。 */
export interface FileViewerFile {
  path: string
  text: string
  truncated: boolean
  binary: boolean
  size: number
  mtimeMs: number
  eol: "lf" | "crlf"
  image?: { mime: string; base64: string } | undefined
}

/** 文件标签文案；容器按 locale 注入。 */
export interface FileViewerLabels {
  loading: string
  binary: string
  truncated: string
  imageTooLarge: string
  save: string
  saving: string
  unsaved: string
  conflict: string
  reload: string
  overwrite: string
  showExplorer: string
  hideExplorer: string
  more: string
  editor: string
  breadcrumbs: string
}

const DEFAULT_LABELS: FileViewerLabels = {
  loading: "正在读取文件…",
  binary: "二进制文件，无法预览",
  truncated: "文件较大，只显示前 1 MB，只读",
  imageTooLarge: "图片太大，无法预览",
  save: "保存",
  saving: "正在保存…",
  unsaved: "未保存",
  conflict: "这个文件在磁盘上被修改过。",
  reload: "放弃修改并重新加载",
  overwrite: "仍然保存",
  showExplorer: "显示文件树",
  hideExplorer: "隐藏文件树",
  more: "更多操作",
  editor: "文件内容",
  breadcrumbs: "文件路径",
}

/** 文件标签属性；读取、保存与草稿都由容器管理。 */
export interface FileViewerProps {
  path: string
  rootName: string
  file: FileViewerFile | null
  loading?: boolean | undefined
  error?: string | null | undefined
  /** 未保存的内容；没有修改时为 null。 */
  draft: string | null
  onDraftChange: (draft: string | null) => void
  onSave: () => void
  saving?: boolean | undefined
  /** 磁盘上的文件在读取后变了，而这里还有未保存的修改。 */
  conflict?: boolean | undefined
  onReload: () => void
  onOverwrite: () => void
  explorerOpen: boolean
  onToggleExplorer: () => void
  /** 点击面包屑里的目录；空字符串是根目录。 */
  onNavigate: (directory: string) => void
  /** 「更多」按钮：容器弹出复制路径、在文件管理器中显示等菜单。 */
  onMore?: ((point: { x: number; y: number }) => void) | undefined
  revealLine?: number | null | undefined
  labels?: Partial<FileViewerLabels> | undefined
}

/** 把字节数写成 KB / MB。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 图片预览：棋盘格背景上居中显示，加载后标出像素尺寸。 */
function ImagePreview({ src, alt }: { src: string; alt: string }) {
  // 尺寸跟着图片地址记录：data URL 解码很快，load 可能早于任何清理逻辑。
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null)
  return (
    <figure className="file-image">
      <img
        src={src}
        alt={alt}
        onLoad={(event) =>
          setSize({
            src,
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
      />
      {size?.src === src ? <figcaption>{`${size.width} × ${size.height}`}</figcaption> : null}
    </figure>
  )
}

/** 渲染文件标签。 */
export function FileViewer({
  path,
  rootName,
  file,
  loading = false,
  error = null,
  draft,
  onDraftChange,
  onSave,
  saving = false,
  conflict = false,
  onReload,
  onOverwrite,
  explorerOpen,
  onToggleExplorer,
  onNavigate,
  onMore,
  revealLine = null,
  labels: overrides,
}: FileViewerProps) {
  const labels = { ...DEFAULT_LABELS, ...overrides }
  const segments = path.split("/")
  const dirty = draft !== null
  const editable = Boolean(file && !file.binary && !file.truncated)
  const language = languageForPath(path)

  let body
  if (error) body = <p className="workbench-error">{error}</p>
  else if (!file) body = <p className="workbench-empty">{loading ? labels.loading : null}</p>
  else if (file.image) {
    body = <ImagePreview src={`data:${file.image.mime};base64,${file.image.base64}`} alt={path} />
  } else if (file.binary) {
    body = (
      <p className="workbench-empty">
        {file.truncated ? labels.imageTooLarge : labels.binary} · {formatSize(file.size)}
      </p>
    )
  } else {
    body = (
      <CodeEditor
        value={draft ?? file.text}
        language={language}
        readOnly={!editable}
        label={`${labels.editor} ${path}`}
        revealLine={revealLine}
        onChange={(text) => onDraftChange(text === file.text ? null : text)}
        onSave={() => {
          if (dirty && !saving) onSave()
        }}
      />
    )
  }

  return (
    <section className="file-view" aria-label={path}>
      <header className="file-view-head">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={explorerOpen}
          aria-label={explorerOpen ? labels.hideExplorer : labels.showExplorer}
          title={explorerOpen ? labels.hideExplorer : labels.showExplorer}
          onClick={onToggleExplorer}
        >
          {explorerOpen ? (
            <PanelLeftClose className="ic ic-sm" aria-hidden="true" />
          ) : (
            <PanelLeftOpen className="ic ic-sm" aria-hidden="true" />
          )}
        </button>
        <nav className="file-crumbs" aria-label={labels.breadcrumbs}>
          <button type="button" className="file-crumb" onClick={() => onNavigate("")}>
            {rootName}
          </button>
          {segments.map((segment, index) => {
            const last = index === segments.length - 1
            const directory = segments.slice(0, index + 1).join("/")
            return (
              <span key={directory} className="file-crumb-part">
                <ChevronRight className="ic ic-xs" aria-hidden="true" />
                {last ? (
                  <span className="file-crumb is-current" aria-current="page">
                    {segment}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="file-crumb"
                    onClick={() => onNavigate(directory)}
                  >
                    {segment}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
        <span className="file-view-meta">
          {dirty ? <span className="file-dirty">{labels.unsaved}</span> : null}
          {file && !file.binary ? <span>{formatSize(file.size)}</span> : null}
          {file?.eol === "crlf" ? <span>CRLF</span> : null}
        </span>
        {dirty ? (
          <button
            type="button"
            className="btn btn-primary btn-sm file-save"
            disabled={saving}
            onClick={onSave}
          >
            <Save className="ic ic-sm" aria-hidden="true" />
            {saving ? labels.saving : labels.save}
          </button>
        ) : null}
        {onMore ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={labels.more}
            title={labels.more}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              onMore({ x: box.left, y: box.bottom })
            }}
          >
            <Ellipsis className="ic ic-sm" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {conflict ? (
        <div className="file-banner" role="alert">
          <span>{labels.conflict}</span>
          <button type="button" className="btn btn-sm" onClick={onReload}>
            {labels.reload}
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={onOverwrite}>
            {labels.overwrite}
          </button>
        </div>
      ) : null}
      {file?.truncated && !file.binary ? (
        <p className="file-banner is-info">{labels.truncated}</p>
      ) : null}
      <div className="file-view-body">{body}</div>
    </section>
  )
}

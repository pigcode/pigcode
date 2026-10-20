/** 文件预览：展示 Host 读取的文本内容，二进制文件只显示提示。 */

/** 一次文件读取结果；字段与 workspace.readFile 的返回值一致。 */
export interface FilePreviewFile {
  path: string
  text: string
  truncated?: boolean
  binary?: boolean
}

/** 文件预览属性；加载与错误状态由父组件传入。 */
export interface FilePreviewProps {
  file: FilePreviewFile | null
  loading?: boolean
  error?: string | null
}

/** 文件预览入口；不读取任何本地路径，内容全部来自 props。 */
export function FilePreview({ file, loading = false, error = null }: FilePreviewProps) {
  if (error) return <p className="workbench-error">{error}</p>
  if (loading) return <p className="workbench-empty">正在读取文件…</p>
  if (!file) return <p className="workbench-empty">选择文件以预览内容</p>

  return (
    <section className="file-preview" aria-label={`文件预览 ${file.path}`}>
      <header className="file-preview-header" title={file.path}>
        {file.path}
      </header>
      {file.binary ? (
        <p className="workbench-empty">二进制文件</p>
      ) : (
        <pre className="file-preview-text">{file.text}</pre>
      )}
      {file.truncated ? <p className="file-preview-note">文件过大，仅显示前 1MB。</p> : null}
    </section>
  )
}

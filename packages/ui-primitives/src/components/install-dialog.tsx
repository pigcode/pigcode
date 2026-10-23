/**
 * 安装插件的对话框（Agent 页与插件管理页共用）：npm 包、tarball 或本地插件目录，可选「选择文件夹」，
 * 并提示插件以 Host 权限运行。安装失败时显示原因并保持打开，成功后关闭并清空输入。
 */
import { useState, type FormEvent } from "react"
import { FolderOpen, ShieldAlert } from "lucide-react"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { Input } from "./input"

/** 对话框文案；failed 里的 `{reason}` 换成失败原因。 */
export interface InstallDialogLabels {
  title: string
  description: string
  spec: string
  placeholder: string
  chooseFolder: string
  trust: string
  cancel: string
  submit: string
  installing: string
  failed: string
}

/** 对话框属性；onInstall 失败时抛错。 */
export interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (spec: string) => Promise<void>
  labels: InstallDialogLabels
  /** 输入框的 id，供页面与测试定位。 */
  inputId: string
  /** 选择本地插件目录；没有时不显示按钮。 */
  onPickFolder?: (() => Promise<string | null>) | undefined
}

/** 渲染安装对话框。 */
export function InstallDialog({
  open,
  onOpenChange,
  onInstall,
  labels,
  inputId,
  onPickFolder,
}: InstallDialogProps) {
  const [spec, setSpec] = useState("")
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const value = spec.trim()
    if (!value) return
    setInstalling(true)
    setError(null)
    try {
      await onInstall(value)
      setSpec("")
      onOpenChange(false)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(labels.failed.replace("{reason}", message))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!installing) onOpenChange(next)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="install-dialog">
          <form onSubmit={(event) => void submit(event)}>
            <Dialog.Title className="install-dialog-title">{labels.title}</Dialog.Title>
            <Dialog.Description className="install-dialog-desc">
              {labels.description}
            </Dialog.Description>
            <label className="install-dialog-label" htmlFor={inputId}>
              {labels.spec}
            </label>
            <div className="install-dialog-input">
              <Input
                id={inputId}
                className="mono"
                value={spec}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder={labels.placeholder}
                onChange={(event) => setSpec(event.target.value)}
              />
              {onPickFolder ? (
                <Button
                  size="sm"
                  type="button"
                  disabled={installing}
                  onClick={() => {
                    void onPickFolder().then((folder) => {
                      if (folder) setSpec(folder)
                    })
                  }}
                >
                  <FolderOpen className="ic ic-sm" aria-hidden="true" />
                  {labels.chooseFolder}
                </Button>
              ) : null}
            </div>
            <p className="install-dialog-trust">
              <ShieldAlert className="ic ic-sm" aria-hidden="true" />
              {labels.trust}
            </p>
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
            <div className="install-dialog-actions">
              <Dialog.Close render={<Button type="button" variant="ghost" disabled={installing} />}>
                {labels.cancel}
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={installing || !spec.trim()}>
                {installing ? labels.installing : labels.submit}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// 本地插件安装表单：输入插件目录并调用 onInstall(path)。
import { useState, type FormEvent } from "react"
import { Button, Input, useLocale } from "@pigcode/ui-primitives"

/** 安装表单需要的回调。 */
export interface InstallFormProps {
  onInstall: (sourceDir: string) => Promise<void>
}

/** 渲染本地插件目录输入；成功后清空输入，失败时显示本地化错误。 */
export function InstallForm({ onInstall }: InstallFormProps) {
  const { t } = useLocale()
  const [sourceDir, setSourceDir] = useState("")
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const path = sourceDir.trim()
    if (!path) {
      setError(t("plugins.required"))
      return
    }
    setInstalling(true)
    setError(null)
    try {
      await onInstall(path)
      setSourceDir("")
    } catch {
      setError(t("plugins.installFailed"))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <form className="section" onSubmit={(event) => void submit(event)}>
      <div className="section-head">
        <h2>{t("plugins.install")}</h2>
      </div>
      <div className="group">
        <div className="item">
          <div className="main">
            <label className="label" htmlFor="plugin-source-dir">
              {t("plugins.directory")}
            </label>
            <div className="hint">{t("plugins.directory.hint")}</div>
            <Input
              id="plugin-source-dir"
              value={sourceDir}
              placeholder={t("plugins.directory.placeholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSourceDir(event.target.value)}
            />
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="trail">
            <Button type="submit" size="sm" variant="primary" disabled={installing}>
              {installing ? t("plugins.installing") : t("plugins.install")}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

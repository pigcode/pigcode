// 插件安装表单：接受本地目录或 npm 包 spec，并提示插件以 Host 权限运行。
import { useState, type FormEvent } from "react"
import { Button, Input, useLocale } from "@pigcode/ui-primitives"

/** 安装表单需要的回调；spec 可以是本地目录、tarball 或 npm 包名/版本。 */
export interface InstallFormProps {
  onInstall: (spec: string) => Promise<void>
}

/** 渲染安装来源输入；成功后清空输入，失败时显示本地化错误。 */
export function InstallForm({ onInstall }: InstallFormProps) {
  const { t } = useLocale()
  const [spec, setSpec] = useState("")
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const value = spec.trim()
    if (!value) {
      setError(t("plugins.required"))
      return
    }
    setInstalling(true)
    setError(null)
    try {
      await onInstall(value)
      setSpec("")
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
            <label className="label" htmlFor="plugin-install-spec">
              {t("plugins.installSpec")}
            </label>
            <div className="hint">{t("plugins.installSpecHint")}</div>
            <Input
              id="plugin-install-spec"
              value={spec}
              placeholder={t("plugins.installSpecPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSpec(event.target.value)}
            />
            <div className="hint">{t("plugins.trustWarning")}</div>
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

// 「添加插件市场」对话框：必须先勾选风险确认，勾选只属于这一次打开；失败时保留输入和勾选、显示原因。
// 市场源管理在 marketplace-sources.tsx。
import { useEffect, useId, useState, type FormEvent } from "react"
import { Check, FolderOpen, ShieldAlert } from "lucide-react"
import { Button, Checkbox, Dialog, Input, useLocale } from "@pigcode/ui-primitives"
import { fill, pluginErrorText } from "./plugin-summary"

export interface AddMarketplaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 添加市场；失败时抛错，对话框显示原因并保持打开。 */
  onAdd: (source: string) => Promise<void>
  /** 选择本地文件夹；没有时不显示按钮。 */
  onPickFolder?: (() => Promise<string | null>) | undefined
}

export function AddMarketplaceDialog({
  open,
  onOpenChange,
  onAdd,
  onPickFolder,
}: AddMarketplaceDialogProps) {
  const { t } = useLocale()
  const inputId = useId()
  const checkId = useId()
  const [source, setSource] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = source.trim()

  // 风险确认只属于这一次打开：关掉以后下次要重新勾选。
  useEffect(() => {
    if (open) return
    setAcknowledged(false)
    setError(null)
  }, [open])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!value || !acknowledged || adding) return
    setAdding(true)
    setError(null)
    try {
      await onAdd(value)
      setSource("")
      onOpenChange(false)
    } catch (cause) {
      setError(fill(t("plugins.failed"), { reason: pluginErrorText(cause, t) }))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!adding) onOpenChange(next)
      }}
    >
      <Dialog.Content
        className="install-dialog marketplace-dialog"
        title={t("plugins.addMarket.title")}
        description={t("plugins.addMarket.description")}
        closeLabel={t("common.close")}
        closeDisabled={adding}
      >
        <form onSubmit={(event) => void submit(event)}>
          <Dialog.Body>
            <div className="field">
              <label className="label" htmlFor={inputId}>
                {t("plugins.addMarket.source")}
              </label>
              <div className="install-dialog-input">
                <Input
                  id={inputId}
                  className="mono"
                  value={source}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("plugins.addMarket.placeholder")}
                  onChange={(event) => setSource(event.target.value)}
                />
                {onPickFolder ? (
                  <Button
                    size="sm"
                    type="button"
                    disabled={adding}
                    onClick={() => {
                      void onPickFolder().then((folder) => {
                        if (folder) setSource(folder)
                      })
                    }}
                  >
                    <FolderOpen className="ic ic-sm" aria-hidden="true" />
                    {t("agents.install.chooseFolder")}
                  </Button>
                ) : null}
              </div>
              <span className="hint">{t("plugins.addMarket.examples")}</span>
            </div>
            <p className="marketplace-risk">
              <ShieldAlert className="ic ic-sm" aria-hidden="true" />
              {t("plugins.addMarket.risk")}
            </p>
            <label className="marketplace-ack" htmlFor={checkId}>
              <Checkbox.Root
                id={checkId}
                checked={acknowledged}
                disabled={adding}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              >
                <Checkbox.Indicator>
                  <Check className="ic ic-xs" aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span>{t("plugins.addMarket.acknowledge")}</span>
            </label>
            {error ? (
              <p className="error-text" role="alert">
                {error}
              </p>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close render={<Button type="button" variant="ghost" disabled={adding} />}>
              {t("agents.install.cancel")}
            </Dialog.Close>
            <Button type="submit" variant="primary" disabled={!value || !acknowledged || adding}>
              {adding ? t("plugins.addMarket.adding") : t("plugins.addMarket.submit")}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}

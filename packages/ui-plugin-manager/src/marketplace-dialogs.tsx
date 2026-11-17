// 插件页的「添加」菜单和添加市场对话框。
import { useEffect, useId, useState, type FormEvent } from "react"
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Plus,
  ShieldAlert,
  Sparkles,
  Store,
} from "lucide-react"
import { Button, Checkbox, Dialog, Input, Menu, useLocale } from "@pigcode/ui-primitives"
import { fill, pluginErrorText } from "./plugin-summary"

export function PluginAddMenu({
  onCreatePlugin,
  onAddMarketplace,
  onInstall,
}: {
  onCreatePlugin?: (() => void) | undefined
  onAddMarketplace: () => void
  onInstall: () => void
}) {
  const { t } = useLocale()
  return (
    <Menu.Root>
      <Menu.Trigger className="btn btn-secondary btn-lg">
        <Plus className="ic ic-sm" aria-hidden="true" />
        {t("plugins.add")}
        <ChevronDown className="ic ic-sm" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="market-add-menu">
            {onCreatePlugin ? (
              <Menu.Item onClick={onCreatePlugin}>
                <Sparkles className="ic" aria-hidden="true" />
                <span className="grow">
                  {t("plugins.add.create")}
                  <span className="menu-item-desc">{t("plugins.add.createHint")}</span>
                </span>
              </Menu.Item>
            ) : null}
            <Menu.Item onClick={onAddMarketplace}>
              <Store className="ic" aria-hidden="true" />
              <span className="grow">
                {t("plugins.add.marketplace")}
                <span className="menu-item-desc">{t("plugins.add.marketplaceHint")}</span>
              </span>
            </Menu.Item>
            <Menu.Item onClick={onInstall}>
              <Download className="ic" aria-hidden="true" />
              <span className="grow">
                {t("plugins.add.install")}
                <span className="menu-item-desc">{t("plugins.add.installHint")}</span>
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

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
                  size="lg"
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
                    size="lg"
                    type="button"
                    disabled={adding}
                    onClick={() => {
                      void onPickFolder().then((folder) => {
                        if (folder) setSource(folder)
                      })
                    }}
                  >
                    <FolderOpen className="ic ic-sm" aria-hidden="true" />
                    {t("plugins.chooseFolder")}
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
            <Dialog.Close
              render={<Button type="button" size="lg" variant="ghost" disabled={adding} />}
            >
              {t("common.cancel")}
            </Dialog.Close>
            <Button
              type="submit"
              size="lg"
              variant="primary"
              disabled={!value || !acknowledged || adding}
            >
              {adding ? t("plugins.addMarket.adding") : t("plugins.addMarket.submit")}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}

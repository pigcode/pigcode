/** 「添加项目」对话框：填写文件夹路径，确认后交给调用方创建项目。 */
import { useState, type CSSProperties } from "react"
import { Button, Dialog, Input, useLocale } from "@pigcode/ui-primitives"

/** Base UI 的 Popup 不带定位，用固定定位把对话框居中。 */
const centeredPopupStyle: CSSProperties = {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 81,
}

/** 取路径最后一段作为项目名；去掉结尾斜杠，空路径返回空字符串。 */
export function projectNameFromPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "")
  if (!trimmed) return ""
  const parts = trimmed.split(/[\\/]+/)
  return parts[parts.length - 1] ?? ""
}

/** 添加项目对话框；关闭时清空输入。M0-B 先用文本输入，不接原生目录选择。 */
export function AddProjectDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (path: string) => void
}) {
  const { t } = useLocale()
  const [path, setPath] = useState("")
  const name = projectNameFromPath(path)

  function close(next: boolean): void {
    if (!next) setPath("")
    onOpenChange(next)
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="dialog" style={centeredPopupStyle}>
          <div className="dialog-head">
            <Dialog.Title>{t("project.add.title")}</Dialog.Title>
            <Dialog.Description>{t("project.add.description")}</Dialog.Description>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!name) return
              onAdd(path.trim())
              close(false)
            }}
          >
            <div className="dialog-body">
              <div className="field">
                <label htmlFor="project-path" className="label">
                  {t("project.add.folder")}
                </label>
                <Input
                  id="project-path"
                  className="mono"
                  value={path}
                  autoFocus
                  spellCheck={false}
                  placeholder={t("project.add.placeholder")}
                  onChange={(event) => setPath(event.target.value)}
                />
                <span className="hint">
                  {name ? `${t("project.add.namePrefix")}${name}` : t("project.add.hint")}
                </span>
              </div>
            </div>
            <div className="dialog-foot">
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={!name}>
                {t("common.add")}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

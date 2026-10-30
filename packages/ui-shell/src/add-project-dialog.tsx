/**
 * 「创建项目」对话框：项目名称、设备与源文件夹。
 * 源文件夹通过系统自带的文件管理器选择；项目名称留空时用文件夹名。
 */
import { useState, type CSSProperties } from "react"
import { Button, Dialog, Input, Select, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

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

/** 对话框属性。 */
export interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建项目；name 为 undefined 时由 Host 取文件夹名。 */
  onAdd: (rootPath: string, name?: string) => void
}

/** 创建项目对话框；关闭时清空已填内容。 */
export function AddProjectDialog({ open, onOpenChange, onAdd }: AddProjectDialogProps) {
  const { t } = useLocale()
  const [name, setName] = useState("")
  const [folder, setFolder] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const folderName = folder ? projectNameFromPath(folder) : ""
  const canPick = typeof window !== "undefined" && Boolean(window.pigcodeNative?.pickFolder)
  const devices = [{ value: "local", label: t("project.add.thisComputer") }]

  function close(next: boolean): void {
    if (!next) {
      setName("")
      setFolder(null)
    }
    onOpenChange(next)
  }

  /** 打开系统文件夹选择框；返回选中的路径，取消或正在选择时返回 null。 */
  async function chooseFolder(): Promise<string | null> {
    const pick = window.pigcodeNative?.pickFolder
    if (!pick || picking) return null
    setPicking(true)
    try {
      const chosen = await pick({
        title: t("project.add.pickerTitle"),
        buttonLabel: t("project.add.pickerButton"),
      })
      if (chosen) setFolder(chosen)
      return chosen
    } finally {
      setPicking(false)
    }
  }

  /** 还没选文件夹时先打开选择框，选好后直接创建；取消则什么都不做。 */
  async function create(): Promise<void> {
    const rootPath = folder ?? (await chooseFolder())
    if (!rootPath) return
    onAdd(rootPath, name.trim() || undefined)
    close(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Backdrop className="project-scrim" />
        <Dialog.Popup className="project-dialog" style={centeredPopupStyle}>
          <div className="project-dialog-head">
            <Dialog.Title>{t("project.add.title")}</Dialog.Title>
            <Dialog.Close
              className="icon-btn project-dialog-close"
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              <Icon name="x" />
            </Dialog.Close>
          </div>
          <form
            className="project-dialog-body"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <div className="project-field">
              <label htmlFor="project-name" className="project-label">
                {t("project.add.name")}
              </label>
              <Input
                id="project-name"
                className="project-input"
                value={name}
                autoFocus
                maxLength={120}
                spellCheck={false}
                autoComplete="off"
                placeholder={folderName || t("project.add.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Select.Root items={devices} defaultValue="local">
              <div className="project-field">
                <Select.Label className="project-label">{t("project.add.device")}</Select.Label>
                <Select.Trigger className="project-input project-select">
                  <Icon name="monitor" />
                  <Select.Value className="grow" />
                  <Select.Icon className="project-select-caret">
                    <Icon name="down" small />
                  </Select.Icon>
                </Select.Trigger>
              </div>
              <Select.Portal>
                <Select.Positioner
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  alignItemWithTrigger={false}
                >
                  <Select.Popup className="project-select-popup">
                    {devices.map((device) => (
                      <Select.Item key={device.value} value={device.value}>
                        <Icon name="monitor" />
                        <Select.ItemText className="grow">{device.label}</Select.ItemText>
                        <Select.ItemIndicator className="check-mark">
                          <Icon name="check" small />
                        </Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
            <div className="project-field" role="group" aria-labelledby="project-folder-label">
              <span id="project-folder-label" className="project-label">
                {t("project.add.folder")}
              </span>
              <button
                type="button"
                className="project-folder"
                data-selected={folder ? "" : undefined}
                aria-label={
                  folder ? `${t("project.add.change")} ${folder}` : t("project.add.choose")
                }
                aria-busy={picking || undefined}
                disabled={!canPick}
                onClick={() => void chooseFolder()}
              >
                <span className="project-folder-icon" aria-hidden="true">
                  <Icon name={folder ? "folder" : "folder-plus"} />
                </span>
                <strong className="project-folder-title truncate">
                  {folder ? folderName : t("project.add.choose")}
                </strong>
                <span className="project-folder-hint truncate">
                  {folder ?? t("project.add.chooseHint")}
                </span>
              </button>
            </div>
            <div className="project-dialog-foot">
              <Button
                type="button"
                variant="ghost"
                className="project-cancel"
                onClick={() => close(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="project-create"
                disabled={!folder && !canPick}
              >
                {t("project.add.create")}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

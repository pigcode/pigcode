/**
 * 「创建项目」对话框：项目名称与源文件夹。
 * 源文件夹通过系统自带的文件管理器选择；项目名称留空时用文件夹名。
 */
import { useEffect, useRef, useState } from "react"
import { HOST_LOCAL_ID, type HostBrowseDirsResult, type HostSummary } from "@pigcode/contracts"
import { Button, Dialog, HostPickerMenu, Input, Spinner, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

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
  /** 可选多主机列表；有 2 台及以上主机时显示目标主机选择。 */
  hosts?: readonly HostSummary[] | undefined
  /** 初始目标主机 id；默认本机。 */
  targetHostId?: string | undefined
  /** 远程主机目录浏览回调（调用 host.browseDirs）。 */
  browseRemoteDirs?: ((hostId: string, path?: string) => Promise<HostBrowseDirsResult>) | undefined
  /** 创建项目；name 为 undefined 时由 Host 取文件夹名。 */
  onAdd: (rootPath: string, name?: string, hostId?: string) => void
}

/** 创建项目对话框；关闭时清空已填内容。 */
export function AddProjectDialog({
  open,
  onOpenChange,
  hosts,
  targetHostId,
  browseRemoteDirs,
  onAdd,
}: AddProjectDialogProps) {
  const { t } = useLocale()
  const [name, setName] = useState("")
  const [folder, setFolder] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [selectedHostId, setSelectedHostId] = useState(targetHostId ?? HOST_LOCAL_ID)
  const [remoteListing, setRemoteListing] = useState<HostBrowseDirsResult | null>(null)
  const [remotePathInput, setRemotePathInput] = useState("")
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const browseSeqRef = useRef(0)
  const pathEditedRef = useRef(false)

  const showHostPicker = Boolean(hosts && hosts.length >= 2)
  const isRemote = selectedHostId !== HOST_LOCAL_ID
  const effectiveFolder = isRemote ? (folder ?? remoteListing?.path ?? null) : folder
  const folderName = effectiveFolder ? projectNameFromPath(effectiveFolder) : ""
  const canPick = typeof window !== "undefined" && Boolean(window.pigcodeNative?.pickFolder)

  useEffect(() => {
    if (!open) return
    browseSeqRef.current += 1
    pathEditedRef.current = false
    setSelectedHostId(targetHostId ?? HOST_LOCAL_ID)
    setFolder(null)
    setRemoteListing(null)
    setRemotePathInput("")
    setRemoteError(null)
    setRemoteLoading(false)
  }, [open, targetHostId])

  useEffect(() => {
    if (!open || !isRemote || !browseRemoteDirs) return
    const seq = ++browseSeqRef.current
    pathEditedRef.current = false
    setRemoteLoading(true)
    setRemoteError(null)
    void browseRemoteDirs(selectedHostId)
      .then((res) => {
        if (browseSeqRef.current !== seq) return
        setRemoteListing(res)
        if (!pathEditedRef.current) {
          setRemotePathInput(res.path)
          setFolder(res.path)
        }
      })
      .catch((err: unknown) => {
        if (browseSeqRef.current === seq) {
          setRemoteError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (browseSeqRef.current === seq) setRemoteLoading(false)
      })
  }, [open, isRemote, selectedHostId, browseRemoteDirs])

  function close(next: boolean): void {
    if (!next) {
      browseSeqRef.current += 1
      setName("")
      setFolder(null)
      setRemoteListing(null)
      setRemoteError(null)
      setRemoteLoading(false)
    }
    onOpenChange(next)
  }

  async function navigateRemote(path?: string): Promise<void> {
    if (!browseRemoteDirs) return
    const seq = ++browseSeqRef.current
    pathEditedRef.current = false
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await browseRemoteDirs(selectedHostId, path)
      if (browseSeqRef.current !== seq) return
      setRemoteListing(res)
      setRemotePathInput(res.path)
      setFolder(res.path)
    } catch (err) {
      if (browseSeqRef.current === seq) {
        setRemoteError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (browseSeqRef.current === seq) setRemoteLoading(false)
    }
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

  /** 还没选文件夹时：本机调用系统选择器，远程提交当前输入/浏览路径；取消则不动。 */
  async function create(): Promise<void> {
    if (isRemote) {
      const remotePath = (remotePathInput.trim() || effectiveFolder || "").trim()
      if (!remotePath) return
      onAdd(remotePath, name.trim() || undefined, selectedHostId)
      close(false)
      return
    }
    const rootPath = folder ?? (await chooseFolder())
    if (!rootPath) return
    if (hosts) onAdd(rootPath, name.trim() || undefined, selectedHostId)
    else onAdd(rootPath, name.trim() || undefined)
    close(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Content
        className="project-dialog"
        title={t("project.add.title")}
        closeLabel={t("common.close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Dialog.Body>
            {showHostPicker && hosts ? (
              <div className="field">
                <span className="label">{t("hosts.targetHost")}</span>
                <div>
                  <HostPickerMenu
                    hosts={hosts}
                    value={selectedHostId}
                    onlineOnly
                    onChange={(nextId) => {
                      browseSeqRef.current += 1
                      pathEditedRef.current = false
                      setSelectedHostId(nextId)
                      setFolder(null)
                      setRemoteListing(null)
                      setRemotePathInput("")
                      setRemoteError(null)
                    }}
                  />
                </div>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="project-name" className="label">
                {t("project.add.name")}
              </label>
              <Input
                size="xl"
                id="project-name"
                value={name}
                autoFocus
                maxLength={120}
                spellCheck={false}
                autoComplete="off"
                placeholder={folderName || t("project.add.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field" role="group" aria-labelledby="project-folder-label">
              <span id="project-folder-label" className="label">
                {isRemote ? t("hosts.remoteFolderPicker") : t("project.add.folder")}
              </span>
              {isRemote ? (
                <div className="remote-dir-box">
                  <div className="remote-dir-bar">
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={remoteLoading || !remoteListing?.parentPath}
                      onClick={() => void navigateRemote(remoteListing?.parentPath ?? undefined)}
                    >
                      {t("hosts.parentDir")}
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={remoteLoading}
                      onClick={() => void navigateRemote(remoteListing?.homePath)}
                    >
                      {t("hosts.homeDir")}
                    </Button>
                    <Input
                      className="remote-dir-path"
                      value={remotePathInput}
                      placeholder={t("hosts.remoteFolderPathPlaceholder")}
                      spellCheck={false}
                      onChange={(event) => {
                        pathEditedRef.current = true
                        setRemotePathInput(event.target.value)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && remotePathInput.trim()) {
                          event.preventDefault()
                          void navigateRemote(remotePathInput.trim())
                        }
                      }}
                    />
                  </div>
                  {remoteLoading ? (
                    <div className="remote-dir-bar">
                      <Spinner className="ic ic-sm" />
                    </div>
                  ) : remoteError ? (
                    <p className="error-text">{remoteError}</p>
                  ) : (
                    <div className="remote-dir-list">
                      {remoteListing && remoteListing.entries.length > 0 ? (
                        remoteListing.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className="remote-dir-item"
                            onClick={() => void navigateRemote(entry.path)}
                          >
                            <Icon name="folder" small />
                            <span className="truncate">{entry.name}</span>
                            {entry.isGitRepo ? (
                              <span className="remote-dir-git">{t("hosts.gitRepoBadge")}</span>
                            ) : null}
                          </button>
                        ))
                      ) : (
                        <span className="hint">{t("hosts.emptyDir")}</span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
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
              )}
            </div>
          </Dialog.Body>
          <Dialog.Footer>
            <Button size="lg" type="button" variant="ghost" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="lg"
              type="submit"
              variant="primary"
              disabled={
                isRemote ? !remotePathInput.trim() && !effectiveFolder : !folder && !canPick
              }
            >
              {t("project.add.create")}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}

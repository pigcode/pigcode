/** 文件导航、面包屑工具栏共用的系统操作。 */
import { revealLabelKey, type OpenApp } from "@pigcode/ui-shell"
import { copyText, type MessageKey } from "@pigcode/ui-primitives"

export interface FileMenuEntry {
  path: string
  kind: "file" | "directory"
}

/** 拼出用于显示和复制的工作区绝对路径。 */
export function absoluteFilePath(root: string, path: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  return path ? root.replace(/[\\/]+$/, "") + separator + path.split("/").join(separator) : root
}

/** 文件在支持的本机编辑器里打开。 */
async function fileEditors(): Promise<OpenApp[]> {
  const apps = await window.pigcodeNative?.listOpenApps?.()
  return apps?.filter((app) => app.kind === "editor") ?? []
}

/** 在原生菜单中选一个编辑器，或交给系统默认应用。 */
async function chooseEditor(
  point: { x: number; y: number },
  label: string,
): Promise<OpenApp | null | undefined> {
  const popup = window.pigcodeNative?.popupMenu
  if (!popup) return undefined
  const editors = await fileEditors()
  const choice = await popup(
    [
      ...editors.map((editor) => ({ id: editor.id, label: editor.name })),
      { id: "default-app", label },
    ],
    point,
  )
  return choice === "default-app" ? null : editors.find((editor) => editor.id === choice)
}

/** 文件树行与文件工具栏的原生菜单。 */
export async function showFileMenu({
  root,
  entry,
  point,
  t,
  onOpenFile,
  onOpenFileTab,
  onMention,
}: {
  root: string | null
  entry: FileMenuEntry
  point: { x: number; y: number }
  t: (key: MessageKey) => string
  onOpenFile: (path: string) => void
  onOpenFileTab: (path: string) => void
  onMention: (path: string) => void
}): Promise<void> {
  const native = window.pigcodeNative
  if (!native?.popupMenu) return
  const file = entry.kind === "file"
  const absolute = root ? absoluteFilePath(root, entry.path) : null
  const choice = await native.popupMenu(
    [
      ...(file
        ? [
            { id: "open", label: t("files.menu.open") },
            { id: "open-tab", label: t("files.menu.openTab") },
          ]
        : []),
      ...(file && root && native.openWorkspaceFile
        ? [{ id: "open-with", label: t("files.menu.openWith") }]
        : []),
      ...(file && root && native.saveWorkspaceFile
        ? [{ id: "save-as", label: t("files.menu.saveAs") }]
        : []),
      { type: "separator" as const },
      ...(absolute
        ? [
            ...(native.revealPath
              ? [{ id: "reveal", label: entry.path ? t("files.menu.reveal") : t(revealLabelKey()) }]
              : []),
            { id: "copy-path", label: t("files.menu.copyPath") },
          ]
        : []),
      ...(entry.path
        ? [
            { id: "copy-relative", label: t("files.menu.copyRelativePath") },
            { type: "separator" as const },
            { id: "mention", label: t("files.menu.mention") },
          ]
        : []),
    ],
    point,
  )

  if (choice === "open") onOpenFile(entry.path)
  else if (choice === "open-tab") onOpenFileTab(entry.path)
  else if (choice === "mention") onMention(entry.path)
  else if (choice === "copy-relative") await copyText(entry.path)
  else if (choice === "copy-path" && absolute) await copyText(absolute)
  else if (choice === "reveal" && absolute) {
    if (!entry.path && native.openFolder) await native.openFolder(absolute)
    else await native.revealPath?.(absolute)
  } else if (choice === "save-as" && root) {
    await native.saveWorkspaceFile?.(root, entry.path)
  } else if (choice === "open-with" && root) {
    const editor = await chooseEditor(point, t("files.menu.defaultApp"))
    if (editor !== undefined) await native.openWorkspaceFile?.(root, entry.path, editor?.id ?? null)
  }
}

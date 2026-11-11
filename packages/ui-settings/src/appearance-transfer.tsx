// 外观页的主题导入导出：导入读主题文件或主题代码，存进「我的主题」并用上；导出把当前浅色、深色两套颜色存成主题文件。
import { useEffect, useRef } from "react"
import { Download, Upload } from "lucide-react"
import {
  Button,
  editSlot,
  exportCurrentTheme,
  importTheme,
  themeNameFromFile,
  useLocale,
  type AppearanceController,
} from "@pigcode/ui-primitives"
import { fill } from "./schedule-format"

type Mode = "light" | "dark"

/** 导入导出后显示在主题工作台上方的一行说明。 */
export type TransferNotice = { tone: "ok" | "error"; text: string }

/** 本机桥里导出要用的一小块；浏览器里没有，退回浏览器下载。 */
interface SaveBridge {
  saveTextFile?: (fileName: string, text: string) => Promise<boolean>
}

function nativeBridge(): SaveBridge | undefined {
  return (globalThis as { pigcodeNative?: SaveBridge }).pigcodeNative
}

/** 读出选中文件的文本；用 FileReader 而不是 File.text()，测试环境（jsdom）里也能用。 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsText(file)
  })
}

/** 没有本机桥时用一个临时链接触发浏览器下载。 */
function downloadInBrowser(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

/** 「导入」「导出」两个按钮。导入成功后 onImported 告诉页面切到哪个模式。 */
export function ThemeTransferActions({
  appearance,
  onNotice,
  onImported,
}: {
  appearance: AppearanceController
  onNotice: (notice: TransferNotice) => void
  onImported: (modes: Mode[]) => void
}) {
  const { t } = useLocale()
  const input = useRef<HTMLInputElement>(null)

  const importFile = async (file: File) => {
    let text: string
    try {
      text = await readFileText(file)
    } catch {
      onNotice({ tone: "error", text: t("settings.appearance.importFailed") })
      return
    }
    const fallback = themeNameFromFile(file.name) || t("settings.appearance.importedName")
    const result = importTheme(text, fallback, appearance.customThemes)
    if (!result.ok) {
      onNotice({ tone: "error", text: t(result.reason) })
      return
    }
    const { theme, modes } = result
    appearance.saveCustomTheme(theme)
    appearance.update((current) =>
      modes.reduce(
        (next, mode) => editSlot(next, mode, { themeId: theme.id, accentMode: "default" }),
        current,
      ),
    )
    onImported(modes)
    onNotice({
      tone: "ok",
      text: fill(t("settings.appearance.imported"), { name: theme.name }),
    })
  }

  const exportFile = async () => {
    const { fileName, text } = exportCurrentTheme(appearance.settings, appearance.customThemes)
    const save = nativeBridge()?.saveTextFile
    if (!save) {
      downloadInBrowser(fileName, text)
      return
    }
    try {
      if (await save(fileName, text)) {
        onNotice({ tone: "ok", text: t("settings.appearance.exported") })
      }
    } catch {
      onNotice({ tone: "error", text: t("settings.appearance.exportFailed") })
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,.txt,application/json,text/plain"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file) void importFile(file)
        }}
      />
      <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
        <Upload className="ic ic-sm" aria-hidden="true" />
        {t("settings.appearance.import")}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void exportFile()}>
        <Download className="ic ic-sm" aria-hidden="true" />
        {t("settings.appearance.export")}
      </Button>
    </>
  )
}

/** 导入导出的结果说明；成功的几秒后自己消失，失败的留到下一次操作。 */
export function TransferNoticeLine({
  notice,
  onDone,
}: {
  notice: TransferNotice | null
  onDone: () => void
}) {
  useEffect(() => {
    if (notice?.tone !== "ok") return
    const timer = window.setTimeout(onDone, 3000)
    return () => window.clearTimeout(timer)
  }, [notice, onDone])
  // 成功说明放进一直存在的 status 区：读屏只播报已有 live 区里的变化，连区带字一起插进来有的读屏不念
  return (
    <>
      <div role="status" className="theme-notice-region">
        {notice?.tone === "ok" ? (
          <p className="theme-notice" data-tone="ok">
            {notice.text}
          </p>
        ) : null}
      </div>
      {notice?.tone === "error" ? (
        <p className="theme-notice" data-tone="error" role="alert">
          {notice.text}
        </p>
      ) : null}
    </>
  )
}

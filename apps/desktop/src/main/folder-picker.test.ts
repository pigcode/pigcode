/** 验证系统文件夹选择框的参数与返回值。 */
import type { BrowserWindow } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  pickFolder,
  pickPath,
  readExternalUrl,
  readFolderPickerLabels,
  readPathKind,
  type ShowOpenDialog,
} from "./folder-picker"

const window = {} as BrowserWindow

describe("readFolderPickerLabels", () => {
  it("keeps short text labels and drops anything else", () => {
    expect(readFolderPickerLabels({ title: "选择项目文件夹", buttonLabel: "选择" })).toEqual({
      title: "选择项目文件夹",
      buttonLabel: "选择",
    })
    expect(readFolderPickerLabels({ title: "", buttonLabel: 3 })).toEqual({})
    expect(readFolderPickerLabels({ title: "x".repeat(81) })).toEqual({})
    expect(readFolderPickerLabels("选择")).toEqual({})
    expect(readFolderPickerLabels(null)).toEqual({})
  })
})

describe("pickFolder", () => {
  it("opens a directory picker parented to the window and returns the chosen folder", async () => {
    const show = vi.fn<ShowOpenDialog>().mockResolvedValue({
      canceled: false,
      filePaths: ["/home/me/pigcode"],
    })
    await expect(pickFolder(show, window, { title: "选择项目文件夹" })).resolves.toBe(
      "/home/me/pigcode",
    )
    expect(show).toHaveBeenCalledWith(window, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目文件夹",
    })
  })

  it("returns null when the picker is cancelled", async () => {
    const show = vi.fn<ShowOpenDialog>().mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(pickFolder(show, window, {})).resolves.toBeNull()
  })
})

describe("pickPath", () => {
  it("picks files or folders and shows hidden entries", async () => {
    const show = vi.fn<ShowOpenDialog>().mockResolvedValue({
      canceled: false,
      filePaths: ["/home/me/.local/bin/claude"],
    })
    await expect(pickPath(show, window, "file", {})).resolves.toBe("/home/me/.local/bin/claude")
    expect(show).toHaveBeenCalledWith(window, { properties: ["openFile", "showHiddenFiles"] })
    await pickPath(show, window, "directory", { title: "CODEX_HOME" })
    expect(show).toHaveBeenLastCalledWith(window, {
      properties: ["openDirectory", "showHiddenFiles"],
      title: "CODEX_HOME",
    })
    expect(readPathKind("file")).toBe("file")
    expect(readPathKind("socket")).toBeNull()
  })
})

describe("readExternalUrl", () => {
  it("only lets https links without credentials through", () => {
    expect(readExternalUrl("https://claude.com/product/claude-code")).toBe(
      "https://claude.com/product/claude-code",
    )
    expect(readExternalUrl("http://example.com")).toBeNull()
    expect(readExternalUrl("https://user:pass@example.com")).toBeNull()
    expect(readExternalUrl("file:///etc/passwd")).toBeNull()
    expect(readExternalUrl("javascript:alert(1)")).toBeNull()
    expect(readExternalUrl(42)).toBeNull()
  })
})

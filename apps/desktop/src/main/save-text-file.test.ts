import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_TEXT_FILE_BYTES, readTextFileRequest, saveTextFile } from "./save-text-file"

describe("readTextFileRequest", () => {
  it("keeps only the last path segment of the file name", () => {
    expect(readTextFileRequest("../../etc/x.json", "{}")).toEqual({
      fileName: "x.json",
      text: "{}",
    })
    expect(readTextFileRequest("..\\a\\b.json", "{}")?.fileName).toBe("b.json")
  })

  it("rejects bad names, non-strings and oversized text", () => {
    expect(readTextFileRequest("..", "{}")).toBeNull()
    expect(readTextFileRequest("", "{}")).toBeNull()
    expect(readTextFileRequest("a.json", 1)).toBeNull()
    expect(readTextFileRequest("a.json", "x".repeat(MAX_TEXT_FILE_BYTES + 1))).toBeNull()
  })
})

describe("saveTextFile", () => {
  it("writes where the dialog says and reports a cancel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigcode-save-"))
    const target = join(dir, "out.json")
    let defaultPath = ""
    const saved = await saveTextFile(
      async (_parent, options) => {
        defaultPath = options.defaultPath ?? ""
        return { canceled: false, filePath: target }
      },
      {} as never,
      dir,
      { fileName: "theme.json", text: "hello" },
    )
    expect(saved).toBe(true)
    expect(defaultPath).toBe(join(dir, "theme.json"))
    expect(readFileSync(target, "utf8")).toBe("hello")
    const cancelled = await saveTextFile(
      async () => ({ canceled: true, filePath: "" }),
      {} as never,
      dir,
      { fileName: "theme.json", text: "hello" },
    )
    expect(cancelled).toBe(false)
  })
})

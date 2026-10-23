/** 验证高亮语言的选择：文件名与扩展名、代码围栏的语言别名。 */
import { describe, expect, it } from "vitest"
import { languageForFence, languageForPath } from "./highlight"

describe("highlight languages", () => {
  it("picks highlight languages by name and extension", () => {
    expect(languageForPath("src/app.tsx")).toBe("tsx")
    expect(languageForPath("Dockerfile")).toBe("docker")
    expect(languageForPath("Dockerfile.dev")).toBe("docker")
    expect(languageForPath("config/.env.local")).toBe("ini")
    expect(languageForPath("tsconfig.json")).toBe("jsonc")
    expect(languageForPath("notes.unknown")).toBeNull()
    expect(languageForPath("Makefile")).toBe("make")
  })

  it("maps code fence names and aliases", () => {
    expect(languageForFence("ts")).toBe("typescript")
    expect(languageForFence("Bash")).toBe("shellscript")
    expect(languageForFence("json")).toBe("json")
    expect(languageForFence("yml")).toBe("yaml")
    expect(languageForFence("text")).toBeNull()
    expect(languageForFence("")).toBeNull()
  })
})

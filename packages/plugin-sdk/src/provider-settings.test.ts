/** 验证 driver 读取设置值、切分启动参数与 Node 侧路径/环境辅助函数。 */
import { mkdtemp, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { localizeText } from "@pigcode/contracts"
import { expandHome, findExecutable, providerEnvironment, resolveExecutable } from "./node"
import {
  asReasoningEffort,
  parseCliArgs,
  settingBoolean,
  settingEnvironment,
  settingString,
  sortEfforts,
  tokenizeCliArgs,
} from "./provider-settings"

describe("provider settings readers", () => {
  it("treats blank or mistyped values as unset", () => {
    const settings = { binaryPath: "  /opt/claude  ", empty: "   ", count: 3, flag: true }
    expect(settingString(settings, "binaryPath")).toBe("/opt/claude")
    expect(settingString(settings, "empty")).toBeUndefined()
    expect(settingString(settings, "count")).toBeUndefined()
    expect(settingString(undefined, "binaryPath")).toBeUndefined()
    expect(settingBoolean(settings, "flag")).toBe(true)
    expect(settingBoolean(settings, "binaryPath")).toBeUndefined()
  })

  it("keeps valid environment entries and lets later ones win", () => {
    const environment = settingEnvironment({
      environment: [
        { name: "A", value: "1" },
        { name: "1BAD", value: "x" },
        { name: "A", value: "2" },
        "junk",
        { name: "B", value: "" },
      ],
    })
    expect(environment).toEqual([
      { name: "A", value: "2" },
      { name: "B", value: "" },
    ])
    expect(settingEnvironment({ environment: "A=1" })).toEqual([])
  })
})

describe("launch arguments", () => {
  it("splits like a shell without expanding variables", () => {
    expect(tokenizeCliArgs(`--model "gpt 6" --name='a b' plain\\ space $HOME`)).toEqual([
      "--model",
      "gpt 6",
      "--name=a b",
      "plain space",
      "$HOME",
    ])
    expect(tokenizeCliArgs(String.raw`--dir C:\Users\me ""`)).toEqual([
      "--dir",
      String.raw`C:\Users\me`,
      "",
    ])
    expect(tokenizeCliArgs("   ")).toEqual([])
  })

  it("parses long flags into the extraArgs shape", () => {
    expect(parseCliArgs("--chrome --effort high --mcp-config=a.json -v run")).toEqual({
      flags: { chrome: null, effort: "high", "mcp-config": "a.json" },
      positionals: ["-v", "run"],
    })
  })
})

describe("model helpers", () => {
  it("normalizes effort names and orders them", () => {
    expect(asReasoningEffort("Extra High")).toBe("xhigh")
    expect(asReasoningEffort("bogus")).toBeNull()
    expect(sortEfforts(["high", "low", "high", "minimal"])).toEqual(["minimal", "low", "high"])
  })
})

describe("node helpers", () => {
  it("expands the home directory prefix only", () => {
    expect(expandHome("~/.codex", "/home/me")).toBe(join("/home/me", ".codex"))
    expect(expandHome("~", "/home/me")).toBe("/home/me")
    expect(expandHome("/abs/~/x", "/home/me")).toBe("/abs/~/x")
  })

  it("layers settings environment and driver overrides over the base env", () => {
    const env = providerEnvironment(
      [{ name: "FOO", value: "from-settings" }],
      { CODEX_HOME: "/tmp/codex", SKIP: undefined },
      { PATH: "/bin", FOO: "inherited", SKIP: "kept" },
    )
    expect(env).toEqual({
      PATH: "/bin",
      FOO: "from-settings",
      CODEX_HOME: "/tmp/codex",
      SKIP: "kept",
    })
  })

  it("finds executables on the given search path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-sdk-bin-"))
    const tool = join(dir, "pigcode-fake-cli")
    await writeFile(tool, "#!/bin/sh\n")
    await chmod(tool, 0o755)
    expect(findExecutable("pigcode-fake-cli", [], dir)).toBe(tool)
    expect(findExecutable("pigcode-missing-cli", [], dir)).toBeUndefined()
    expect(resolveExecutable("/custom/claude", "claude")).toBe("/custom/claude")
    expect(resolveExecutable(undefined, "pigcode-missing-cli")).toBe("pigcode-missing-cli")
  })
})

describe("localized text", () => {
  it("falls back from locale to language to English to the first entry", () => {
    expect(localizeText("plain", "zh-CN")).toBe("plain")
    expect(localizeText({ zh: "中文", en: "English" }, "zh-CN")).toBe("中文")
    expect(localizeText({ "zh-CN": "中文", "en-US": "English" }, "fr-FR")).toBe("English")
    expect(localizeText({ ja: "日本語" }, "zh-CN")).toBe("日本語")
  })
})

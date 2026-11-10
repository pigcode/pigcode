/** 验证 driver 读取设置值、切分启动参数与 Node 侧路径/环境辅助函数。 */
import { mkdir, mkdtemp, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { localizeText } from "@pigcode/contracts"
import {
  expandHome,
  findExecutable,
  agentEnvironment,
  resolveExecutable,
  launchTarget,
  parseShimTarget,
  shimTarget,
} from "./node"
import {
  asReasoningEffort,
  parseCliArgs,
  settingBoolean,
  settingEnvironment,
  settingString,
  sortEfforts,
  tokenizeCliArgs,
} from "./agent-settings"

describe("agent settings readers", () => {
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
    // 认不得的档位原样保留，发给 agent 时也原样发回去。
    expect(asReasoningEffort("bogus")).toBe("bogus")
    // Codex 的模型目录里在 max 之上还有 ultra 档。
    expect(asReasoningEffort("Ultra")).toBe("ultra")
    expect(sortEfforts(["ultra", "max", "xhigh"])).toEqual(["xhigh", "max", "ultra"])
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
    const env = agentEnvironment(
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

  it("finds the target a Windows shim launches", () => {
    // 当前 npm 包把 claude 装成原生 exe，shim 里最后一段指向它。
    const npmShim = [
      "@ECHO off",
      "SET dp0=%~dp0",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\pkg\\bin\\claude.exe" %*',
    ].join("\r\n")
    expect(parseShimTarget(npmShim)).toBe("%dp0%\\..\\pkg\\bin\\claude.exe")

    // pnpm 的 shim 直接用 %~dp0；前面那段 node.exe 不能被当成目标。
    const pnpmShim = [
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*',
      ")",
    ].join("\r\n")
    expect(parseShimTarget(pnpmShim)).toBe("%~dp0\\..\\@openai\\codex\\bin\\codex.js")
    expect(parseShimTarget("@echo off\r\necho hello\r\n")).toBeUndefined()
  })

  it("launches non-batch commands directly on every platform", () => {
    expect(launchTarget("/usr/local/bin/claude", ["--version"])).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--version"],
      shell: false,
    })
    expect(launchTarget("C:\\Program Files\\nodejs\\node.exe")).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [],
      shell: false,
    })
  })

  it.runIf(process.platform === "win32")("launches a shim's target directly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-shim-"))
    // 原生 exe：shim 解析到它，直接执行，不经过 cmd。
    const bin = join(dir, "pkg", "bin")
    await mkdir(bin, { recursive: true })
    const exe = join(bin, "claude.exe")
    await writeFile(exe, "")
    const shim = join(dir, "claude.cmd")
    await writeFile(
      shim,
      ["@ECHO off", "SET dp0=%~dp0", '"%dp0%\\pkg\\bin\\claude.exe"   %*'].join("\r\n"),
    )
    expect(shimTarget(shim)).toBe(exe)
    expect(launchTarget(shim, ["--version"])).toEqual({
      command: exe,
      args: ["--version"],
      shell: false,
    })

    // JS 入口：交给 node 运行，参数原样保留（不会被 cmd 切分）。
    const script = join(bin, "codex.js")
    await writeFile(script, "")
    const codexShim = join(dir, "codex.cmd")
    await writeFile(
      codexShim,
      [
        '@IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe"  "%~dp0\\pkg\\bin\\codex.js" %*',
        ")",
      ].join("\r\n"),
    )
    expect(launchTarget(codexShim, ["app-server", "--stdio"])).toEqual({
      command: "node",
      args: [script, "app-server", "--stdio"],
      shell: false,
    })

    // pnpm 给 exe 目标生成的 shim 没有 dp0 初始化，只有开头的 @SETLOCAL。
    const pnpmBin = join(dir, "pnpm-bin")
    await mkdir(pnpmBin, { recursive: true })
    const pnpmShim = join(pnpmBin, "claude.cmd")
    await writeFile(pnpmShim, ["@SETLOCAL", '@"%~dp0\\..\\pkg\\bin\\claude.exe"   %*'].join("\r\n"))
    expect(shimTarget(pnpmShim)).toBe(exe)

    // 手写的包装脚本不能解包：它自己 set 的变量会被跳过。
    const wrapper = join(dir, "wrapper.cmd")
    await writeFile(
      wrapper,
      ["@echo off", "set ANTHROPIC_BASE_URL=https://proxy.example", `"${exe}" %*`].join("\r\n"),
    )
    expect(shimTarget(wrapper)).toBeUndefined()

    // 解析不出来时退回 shell，并自己给路径加引号：Node 的 shell 模式不会加。
    const opaque = join(dir, "opaque.cmd")
    await writeFile(opaque, "@echo off\r\n")
    expect(launchTarget(opaque)).toEqual({ command: `"${opaque}"`, args: [], shell: true })
    expect(shimTarget(join(dir, "missing.cmd"))).toBeUndefined()
    expect(shimTarget(script)).toBeUndefined()
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

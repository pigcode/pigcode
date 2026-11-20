import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type Locator } from "@playwright/test"
import { openThread } from "./projects"

const featured = [
  "Codex",
  "Claude Code",
  "Cursor",
  "Grok",
  "OpenCode",
  "Antigravity",
  "Muse Code",
  "Pi",
]
const extra = ["fx", "Kiro"]
const forms: Record<string, string[]> = {
  Cursor: [],
  "Muse Code": ["可执行文件"],
  Pi: ["可执行文件", "启动参数"],
  OpenCode: ["可执行文件", "服务器地址", "服务器密码"],
  fx: ["可执行文件"],
  Kiro: ["可执行文件"],
  Grok: ["可执行文件"],
}

// 实际的 Host、内置插件与 Registry 客户端照常加载，仅替换 Registry 的网络响应。
function registryProfile(directory: string): string {
  const built = fileURLToPath(new URL("../out/host/", import.meta.url))
  const profile = join(directory, "runtime", "profile")
  mkdirSync(profile, { recursive: true })
  for (const part of ["core", "plugins"])
    symlinkSync(join(built, part), join(profile, "..", part), "junction")
  const ids = [
    "claude-acp",
    "codex-acp",
    "cursor",
    "grok-build",
    "antigravity-acp",
    "opencode",
    "opencode-v2",
    "pi-acp",
    "kiro",
    "unlisted-example",
  ]
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  const agents = ids.map((id) => ({
    id,
    name: id,
    description: "Registry fixture",
    version: "1.0.0",
    distribution: {
      binary: {
        [platform + "-" + arch]: { archive: "https://example.invalid/fixture.tgz", cmd: "./agent" },
      },
    },
  }))
  writeFileSync(
    join(profile, "registry.mjs"),
    `export function apply() {
    const original = globalThis.fetch
    globalThis.fetch = (input, init) =>
      String(input) === "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
        ? Promise.resolve(Response.json(${JSON.stringify({ agents })}))
        : original(input, init)
  }`,
  )
  const source = readFileSync(join(built, "profile", "desktop.yml"), "utf8")
  writeFileSync(
    join(profile, "desktop.yml"),
    source.replace("plugins:\n", "plugins:\n  - id: fixture.registry\n    name: ./registry.mjs\n"),
  )
  return profile
}

function grokFixture(directory: string): string {
  const path = join(directory, "grok.mjs")
  writeFileSync(
    path,
    `#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("grok 1.0.0")
else if (process.argv[2] === "models") console.log("You are logged in\\n- grok-fixture (default)")
else process.exitCode = 1
`,
    { mode: 0o700 },
  )
  if (process.platform !== "win32") return path
  const shim = join(directory, "grok.cmd")
  writeFileSync(shim, '@SETLOCAL\r\nnode "%~dp0grok.mjs" %*\r\n')
  return shim
}

async function checkNames(items: Locator, expected: string[]) {
  await expect(items).toHaveCount(expected.length)
  expect((await items.allTextContents()).map((name) => name.trim()).sort()).toEqual(
    [...expected].sort(),
  )
}

test("bundled agent choices, instance fields and native model discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pigcode-native-catalog-"))
  const profile = join(directory, "user")
  const { app, page } = await openThread("native-catalog", {
    PIGCODE_AGENT: "",
    PIGCODE_CORE_PROFILE_DIR: registryProfile(directory),
    PIGCODE_PROFILE_DIR: profile,
  })
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "Agent", exact: true }).first().click()
    const list = page.locator(".agents-list .agent-item-name")
    await checkNames(list, ["Claude Code", "Codex", "Antigravity"])
    await page.getByRole("button", { name: "添加 Agent", exact: true }).click()
    const wizard = page.getByRole("dialog", { name: "添加 Agent" })
    const group = wizard.getByRole("group", { name: "内置" })
    await checkNames(group.getByRole("option"), [...featured, ...extra])
    const catalog = wizard.getByRole("group", { name: "ACP Registry" })
    await expect(catalog.getByRole("option")).toHaveCount(1)
    await expect(catalog.getByRole("option")).toHaveAccessibleName("添加 unlisted-example")
    for (const [agent, fields] of Object.entries(forms)) {
      await wizard.getByRole("option", { name: agent, exact: true }).click()
      if (agent === "Grok") {
        await wizard.getByRole("textbox", { name: "名字" }).fill("Grok 本地")
        await wizard.getByRole("textbox", { name: "ID" }).fill("grok_local")
      }
      // 启动设置收在「高级设置」里；换一个 Agent 时它可能已经打开了。
      const advanced = wizard.getByRole("button", { name: "高级设置" })
      if (fields.length > 0 && (await advanced.getAttribute("aria-expanded")) !== "true")
        await advanced.click()
      const config = wizard.locator(".wizard-config")
      await expect(config.locator("input")).toHaveCount(fields.length)
      for (const label of fields)
        await expect(config.getByLabel(label, { exact: true })).toBeVisible()
      if (agent === "Grok") {
        await config.getByLabel("可执行文件", { exact: true }).fill(grokFixture(directory))
        await wizard.getByRole("button", { name: "创建" }).click()
      } else {
        await wizard.getByRole("button", { name: "返回" }).click()
      }
    }
    await expect(wizard).toBeHidden()
    await expect(page.getByRole("button", { name: "打开 Grok 本地 的设置" })).toHaveAttribute(
      "aria-current",
      "true",
    )
    const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"))
    expect(settings.agentInstances.grok_local).toMatchObject({
      agentId: "grok",
      label: "Grok 本地",
    })
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    await page.getByRole("tab", { name: "Grok 本地" }).click()
    await expect(page.getByRole("listbox", { name: "Grok 本地" })).toContainText("grok-fixture")
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

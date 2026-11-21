/**
 * 插件市场：添加一个本地文件夹的市场（先勾选风险确认），从市场安装插件，插件按创建指南写成的纯 JS 也能直接加载，
 * 改版本号后刷新市场、更新插件；「创建插件」开一个预填了指南的新会话。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { launch } from "../visual/screens"
import { openThread } from "./projects"

const MARKET = "/tmp/pigcode-e2e-market/plugins"
/**
 * 市场和装上的插件都记在 profile 里，每个用例使用独立 profile。
 */
let profileDir = ""

/** 按「Pigcode 插件创建指南」写的插件：纯 JavaScript，一个 MCP 工具加一个侧栏面板，没有构建步骤。 */
function writeMarketplace(version: string): void {
  const plugin = join(MARKET, "word-count")
  mkdirSync(join(MARKET, ".pigcode-plugin"), { recursive: true })
  mkdirSync(plugin, { recursive: true })
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "pigcode-word-count",
      version,
      description: "统计文字的字数",
      type: "module",
      pigcode: {
        apiVersion: 1,
        kind: "capability",
        displayName: "字数统计",
        host: "./host.js",
        client: "./client.js",
        inject: ["mcp"],
        permissions: [],
      },
    }),
  )
  writeFileSync(
    join(plugin, "host.js"),
    `export const name = "pigcode-word-count"
export const inject = ["mcp"]
export function apply(ctx) {
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-word-count",
      { name: "word_count", description: "Count words", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      async (input) => ({ words: String(input.text ?? "").split(/\\s+/).filter(Boolean).length }),
    ),
  )
}
`,
  )
  writeFileSync(
    join(plugin, "client.js"),
    `import { createElement as h, useState } from "react"
import { Button } from "@pigcode/ui-primitives"
function Panel() {
  const [count, setCount] = useState(0)
  return h(Button, { variant: "primary", onClick: () => setCount(count + 1) }, "字数统计 v${version} · " + count)
}
export function apply(ctx) {
  const dispose = ctx.panels.register({ id: "word-count-panel", title: "Word Count", Component: Panel })
  return () => dispose()
}
`,
  )
  writeFileSync(
    join(MARKET, ".pigcode-plugin", "marketplace.json"),
    JSON.stringify({
      name: "dev-e2e",
      displayName: "E2E 插件",
      plugins: [
        {
          name: "pigcode-word-count",
          source: "./word-count",
          displayName: "字数统计",
          description: "统计文字的字数",
          version,
        },
      ],
    }),
  )
}

async function openPlugins(page: Page): Promise<void> {
  await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "插件市场" })).toBeVisible()
}

async function openAddMenu(page: Page): Promise<void> {
  await page.locator(".page-head").getByRole("button", { name: /^添加/ }).click()
}

test.beforeEach(() => {
  rmSync("/tmp/pigcode-e2e-market", { recursive: true, force: true })
  writeMarketplace("0.1.0")
  profileDir = mkdtempSync(join(tmpdir(), "pigcode-e2e-market-profile-"))
})

test.afterEach(() => rmSync(profileDir, { recursive: true, force: true }))

test("the marketplace search fills its own row in a narrow window with large text", async () => {
  const { app, page } = await launch("dark", "en-US")
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("button", { name: "Appearance", exact: true }).first().click()
    await page.getByRole("slider", { name: "Interface text size" }).press("End")
    await expect(page.locator("body")).toHaveCSS("font-size", "18px")
    await page.getByRole("button", { name: "Back to app", exact: true }).first().click()
    await page
      .locator(".side-actions")
      .getByRole("button", { name: "Plugins", exact: true })
      .click()

    const search = page.locator(".market-search")
    await expect(search).toHaveCSS("width", "320px")
    const install = page.getByRole("button", { name: /^Install / }).first()
    await expect(install).toHaveCSS("height", "20px")
    const fontSize = await install.evaluate((button) =>
      parseFloat(getComputedStyle(button).fontSize),
    )
    expect(fontSize).toBeCloseTo((13 * 18) / 13, 3)

    await page.setViewportSize({ width: 560, height: 700 })
    await expect(search).toHaveCSS("height", "28px")
    await expect
      .poll(() =>
        search.evaluate((field) => {
          const toolbar = field.parentElement!
          const tabs = toolbar.querySelector(".market-tabs")!.getBoundingClientRect()
          const row = toolbar.getBoundingClientRect()
          const box = field.getBoundingClientRect()
          return box.top >= tabs.bottom && box.left === row.left && box.width === row.width
        }),
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

test("adds a local marketplace, installs a plugin from it and updates it", async () => {
  const { app, page } = await openThread("plugin-market", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openPlugins(page)
    const toolbar = page.locator(".market-page-head .actions")
    const actions = toolbar.getByRole("button")
    await expect(actions).toHaveCount(4)
    for (const action of await actions.all()) await expect(action).toHaveCSS("height", "28px")
    await expect(toolbar.getByRole("button", { name: "刷新" })).toHaveCSS("width", "28px")
    // 页头按钮、搜索框和目录筛选都是 28 高的胶囊（Cursor 插件页的 rounded Button、shape="pill" 的 InputGroup 与 Pill lg）
    for (const pill of [
      toolbar.getByRole("button", { name: "插件管理" }),
      page.locator(".market-search"),
      page.getByRole("radio", { name: "官方" }),
    ]) {
      await expect(pill).toHaveCSS("height", "28px")
      await expect(pill).toHaveCSS("border-radius", "999px")
    }

    await openAddMenu(page)
    await page.getByRole("menuitem", { name: /添加插件市场/ }).click()
    const dialog = page.getByRole("dialog", { name: "添加插件市场" })
    const source = dialog.getByLabel("地址", { exact: true })
    await expect(source).toHaveCSS("height", "28px")
    await source.fill(MARKET)
    const submit = dialog.getByRole("button", { name: "添加", exact: true })
    await expect(submit).toBeDisabled()
    const acknowledge = dialog.getByRole("checkbox", { name: /我知道风险/ })
    await expect(acknowledge).toHaveCSS("width", "14px")
    await acknowledge.click()
    await submit.click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("radio", { name: "我的" })).toBeChecked()

    const section = page.getByRole("region", { name: "E2E 插件" })
    await expect(section).toContainText("电脑上的文件夹")
    await section.getByRole("button", { name: "安装 字数统计" }).click()
    await expect(section.locator(".market-tile")).toContainText("已安装")
    // 纯 JS 写的界面入口直接加载：侧栏多了它的面板。
    await expect(page.locator(".plugin-panel-head").filter({ hasText: "Word Count" })).toBeVisible()
    await expect(page.getByRole("button", { name: /字数统计 v0\.1\.0/ })).toBeVisible()

    // 管理页读取市场里的新版本并更新，侧栏面板也换成新版本。
    writeMarketplace("0.2.0")
    await page.getByRole("button", { name: "插件管理", exact: true }).click()
    const installed = page.getByRole("region", { name: "已安装" })
    await expect(installed).toContainText("0.1.0")
    await expect(installed).toContainText("E2E 插件")
    await page.getByRole("button", { name: "检查更新" }).click()
    await installed.getByRole("button", { name: "更新 字数统计" }).click()
    await expect(installed).toContainText("0.2.0")
    await expect(page.getByRole("button", { name: /字数统计 v0\.2\.0/ })).toBeVisible()
    await page.getByRole("button", { name: "返回插件市场" }).click()
    await expect(page.getByRole("radio", { name: "我的" })).toBeChecked()
    await expect(section.locator(".market-tile")).toContainText("已安装")

    // 停用市场源：插件市场里不再列出它，装好的插件照常在用；在市场源里重新启用后回来。
    await section.getByRole("button", { name: "E2E 插件 的操作" }).click()
    await page.getByRole("menuitem", { name: "停用这个市场" }).click()
    await expect(section).toBeHidden()
    await expect(page.getByText("插件市场都停用了")).toBeVisible()
    await expect(page.locator(".plugin-panel-head").filter({ hasText: "Word Count" })).toBeVisible()
    await page.getByRole("button", { name: "管理插件市场…" }).click()
    const sources = page.getByRole("dialog", { name: "插件市场" })
    await sources.getByRole("switch", { name: "启用 E2E 插件" }).click()
    await expect(sources.getByRole("status")).toHaveText("2 个插件市场")
    await sources.getByRole("button", { name: "关闭" }).last().click()
    await expect(section).toBeVisible()

    await page.getByRole("button", { name: "插件管理", exact: true }).click()
    await page.getByRole("button", { name: "字数统计 的详情" }).click()
    await expect(page.getByRole("dialog", { name: "字数统计" })).toContainText(
      "pigcode-word-count@dev-e2e",
    )
  } finally {
    await app.close()
  }
})

test("creates a plugin by opening a conversation with the guide attached", async () => {
  const { app, page } = await openThread("plugin-creator", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openPlugins(page)
    await openAddMenu(page)
    await page.getByRole("menuitem", { name: /写一个插件/ }).click()
    await expect(page.locator(".tiptap")).toHaveText("帮我创建一个 Pigcode 插件：")
    await expect(page.locator(".composer-context")).toContainText("怎么写 Pigcode 插件")
    // 光标停在末尾，直接接着写。
    await expect(page.locator(".tiptap")).toBeFocused()
    await page.keyboard.type("统计选中文字的字数")
    await expect(page.locator(".tiptap")).toHaveText(
      "帮我创建一个 Pigcode 插件：统计选中文字的字数",
    )
  } finally {
    await app.close()
  }
})

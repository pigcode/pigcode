/**
 * 插件市场：添加一个本地文件夹的市场（先勾选风险确认），从市场安装插件，插件按创建指南写成的纯 JS 也能直接加载，
 * 改版本号后刷新市场、更新插件；「创建插件」开一个预填了指南的新会话。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { openThread } from "./projects"

const MARKET = "/tmp/pigcode-e2e-market/plugins"
/**
 * 市场和装上的插件都记在 profile 里。其他用例共用同一个 profile，有市场时插件页默认打开市场分段，
 * 所以这里每个用例用自己的 profile。
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
  await expect(page.getByRole("heading", { level: 1, name: "插件" })).toBeVisible()
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

test("adds a local marketplace, installs a plugin from it and updates it", async () => {
  const { app, page } = await openThread("plugin-market", { PIGCODE_PROFILE_DIR: profileDir })
  try {
    await openPlugins(page)
    await openAddMenu(page)
    await page.getByRole("menuitem", { name: /添加插件市场/ }).click()
    const dialog = page.getByRole("dialog", { name: "添加插件市场" })
    await dialog.getByLabel("来源", { exact: true }).fill(MARKET)
    const submit = dialog.getByRole("button", { name: "添加", exact: true })
    await expect(submit).toBeDisabled()
    await dialog.getByRole("checkbox", { name: /我已了解风险/ }).click()
    await submit.click()
    await expect(dialog).toBeHidden()

    const section = page.getByRole("region", { name: "E2E 插件" })
    await expect(section).toContainText("本地文件夹")
    await section.getByRole("button", { name: "安装 字数统计" }).click()
    await expect(section.locator(".market-tile")).toContainText("已安装")
    // 纯 JS 写的界面入口直接加载：侧栏多了它的面板。
    await expect(page.locator(".plugin-panel-head").filter({ hasText: "Word Count" })).toBeVisible()
    await expect(page.getByRole("button", { name: /字数统计 v0\.1\.0/ })).toBeVisible()

    // 改了版本号：刷新市场后卡片上可以更新，更新后侧栏面板换成新版本。
    writeMarketplace("0.2.0")
    await page.getByRole("button", { name: /^市场源/ }).click()
    const sources = page.getByRole("dialog", { name: "市场源" })
    await sources.getByRole("button", { name: "刷新 E2E 插件" }).click()
    await sources.getByRole("button", { name: "关闭" }).last().click()
    await expect(section.locator(".market-tile")).toContainText("可更新")
    await section.getByRole("button", { name: "更新 字数统计" }).click()
    await expect(section.locator(".market-tile")).toContainText("已安装")
    await expect(page.getByRole("button", { name: /字数统计 v0\.2\.0/ })).toBeVisible()

    // 停用市场源：插件市场里不再列出它，装好的插件照常在用；在市场源里重新启用后回来。
    await section.getByRole("button", { name: "E2E 插件 的操作" }).click()
    await page.getByRole("menuitem", { name: "停用这个市场源" }).click()
    await expect(section).toBeHidden()
    await expect(page.getByText("市场源都已停用")).toBeVisible()
    await expect(page.locator(".plugin-panel-head").filter({ hasText: "Word Count" })).toBeVisible()
    await page.getByRole("button", { name: "管理市场源…" }).click()
    await sources.getByRole("switch", { name: "启用 E2E 插件" }).click()
    await expect(sources.getByRole("status")).toHaveText("1 个市场源")
    await sources.getByRole("button", { name: "关闭" }).last().click()
    await expect(section).toBeVisible()

    await page.getByRole("radio", { name: /已安装/ }).click()
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
    await page.getByRole("menuitem", { name: /创建插件/ }).click()
    await expect(page.locator(".tiptap")).toHaveText("帮我创建一个 Pigcode 插件：")
    await expect(page.locator(".composer-context")).toContainText("Pigcode 插件创建指南")
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

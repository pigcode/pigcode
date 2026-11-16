import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { OFFICIAL_MARKETPLACE_BASE } from "../../../marketplace/catalog-source"
import { openThread } from "./projects"

function publishNextVersions(catalogDir: string, names: readonly string[]): void {
  const file = join(catalogDir, "marketplace.json")
  const next = JSON.parse(readFileSync(file, "utf8")) as {
    plugins: { name: string; version: string; source: { url: string; sha256: string } }[]
  }
  for (const entry of next.plugins.filter(({ name }) => names.includes(name))) {
    const stage = mkdtempSync(join(tmpdir(), "pigcode-catalog-release-"))
    try {
      const priorName = basename(new URL(entry.source.url).pathname)
      const nextName = priorName.replace(/-\d+\.\d+\.\d+\.tgz$/u, "-2.0.0.tgz")
      execFileSync("tar", ["-xzf", join(catalogDir, "packages", priorName), "-C", stage])
      const manifestPath = join(stage, "package/package.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "2.0.0" }))
      const artifact = join(catalogDir, "packages", nextName)
      const [pack] = JSON.parse(
        execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
          cwd: join(stage, "package"),
          encoding: "utf8",
        }),
      ) as [{ filename: string }]
      copyFileSync(join(stage, "package", pack.filename), artifact)
      entry.version = "2.0.0"
      entry.source.url = `${OFFICIAL_MARKETPLACE_BASE}/packages/${nextName}`
      entry.source.sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex")
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }
  writeFileSync(file, JSON.stringify(next))
}

async function openMarketplace(page: Page): Promise<void> {
  await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
  await expect(page.getByRole("heading", { name: "插件市场" })).toBeVisible()
}

async function installFromCard(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name: `安装 ${name}`, exact: true })
  const card = page.locator(".market-tile").filter({ hasText: name })
  await button.click()
  await expect(card).toContainText("已安装")
}

async function openSurface(page: Page, title: string, id: string) {
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: title, exact: true }).click()
  const content = page.locator(`[data-plugin-content="${id}"]`)
  await expect(content).toBeVisible()
  return content
}

test("browses, installs, uses and updates real Pigcode catalog plugins", async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), "pigcode-catalog-e2e-"))
  const fixture = process.env.PIGCODE_E2E_CATALOG_DIR
  const catalogDir = join(dir, "catalog")
  if (fixture) cpSync(fixture, catalogDir, { recursive: true })
  const { app, page, root } = await openThread("official-catalog", {
    PIGCODE_PROFILE_DIR: join(dir, "profile"),
    ...(fixture ? { PIGCODE_E2E_CATALOG_DIR: catalogDir } : {}),
  })
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root })
    await openMarketplace(page)
    await expect(page.getByRole("radio", { name: "公开" })).toBeChecked()
    await expect(page.getByRole("button", { name: "Claude Code 的详情" })).toBeVisible()
    await installFromCard(page, "项目概览")
    await installFromCard(page, "文本统计")

    await page.getByRole("radio", { name: "社区" }).click()
    await page.getByRole("button", { name: "Prettier 格式化 的详情" }).click()
    const detail = page.getByRole("dialog", { name: "Prettier 格式化" })
    await expect(detail).toContainText("Prettier contributors")
    await detail.getByRole("button", { name: "安装", exact: true }).click()
    await expect(detail.getByRole("button", { name: "已安装", exact: true })).toBeDisabled()
    await page.keyboard.press("Escape")
    await installFromCard(page, "YAML ↔ JSON 转换")

    await page.getByRole("radio", { name: "个人" }).click()
    await expect(page.getByRole("heading", { name: "还没有个人市场源" })).toBeVisible()
    await page
      .locator(".proj-block")
      .filter({ hasText: "pigcode-e2e-official-catalog" })
      .locator(".proj-add")
      .click()
    await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
    const projects = await openSurface(page, "项目概览", "pigcode.project-overview")
    await expect(projects).toContainText(root)
    await expect(projects).toContainText("src/index.ts")

    const stats = await openSurface(page, "文本统计", "pigcode.text-stats")
    await stats.getByLabel("待统计的文本").fill("猫 test\nx")
    await expect(stats.locator(".list-row").filter({ hasText: "UTF-8 字节" })).toContainText("10")

    const prettier = await openSurface(page, "Prettier 格式化", "pigcode.prettier-format")
    await prettier.getByLabel("原始内容").fill("const thing={x:1}")
    await prettier.getByRole("button", { name: "格式化", exact: true }).click()
    await expect(prettier.getByLabel("结果")).toHaveValue("const thing = { x: 1 };\n")

    const yaml = await openSurface(page, "YAML ↔ JSON 转换", "pigcode.yaml-json")
    await yaml.getByLabel("原始内容").fill("name: Pigcode\nitems:\n  - 3\n")
    await yaml.getByRole("button", { name: "转换", exact: true }).click()
    await expect(yaml.getByLabel("结果")).toHaveValue(
      JSON.stringify({ name: "Pigcode", items: [3] }, null, 2) + "\n",
    )

    if (fixture) {
      publishNextVersions(catalogDir, ["@pigcode/text-stats", "@pigcode/yaml-json"])
      await openMarketplace(page)
      await page.getByRole("button", { name: "刷新", exact: true }).click()
      await page.getByRole("button", { name: "更新 文本统计" }).click()
      await expect
        .poll(async () => {
          const error = (await page.locator(".market-error").allTextContents())[0]
          if (error) throw new Error(error)
          return page.locator(".market-tile").filter({ hasText: "文本统计" }).textContent()
        })
        .toContain("已安装")
      await page.getByRole("button", { name: "插件管理", exact: true }).click()
      const installed = page.getByRole("region", { name: "已安装", exact: true })
      const yamlRow = installed.locator(".market-tile").filter({ hasText: "YAML ↔ JSON 转换" })
      const toggle = yamlRow.getByRole("switch")
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await yamlRow.getByRole("button", { name: "更新 YAML ↔ JSON 转换" }).click()
      await expect(yamlRow).toContainText("2.0.0")
      await expect(toggle).not.toBeChecked()
      await expect(installed.locator(".market-tile").filter({ hasText: "文本统计" })).toContainText(
        "2.0.0",
      )
    }
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

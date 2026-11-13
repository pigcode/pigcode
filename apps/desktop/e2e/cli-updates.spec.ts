/** 第三方 Agent 的 CLI 更新通过同一个检查、更新和日志界面运行。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { installPlugin, launchArgs, launchEnv } from "./projects"
import { releaseServer } from "./update-fixture"

test("runs plugin-owned CLI updates, reports failures and verifies a retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pigcode-cli-update-"))
  const profile = mkdtempSync(join(tmpdir(), "pigcode-update-profile-"))
  const { url, server } = await releaseServer("v9.9.9")
  const versionFile = join(directory, "version.txt")
  writeFileSync(versionFile, "1.0.0")
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "pigcode-agent-cli-updater-test",
      version: "1.0.0",
      type: "module",
      main: "./index.js",
      pigcode: {
        apiVersion: 1,
        kind: "agent",
        displayName: "CLI Update Test",
        host: "./index.js",
        provides: ["agent:cli-update-test"],
        permissions: ["fs:workspace"],
        contributes: { agent: { id: "cli-update-test", settings: [] } },
      },
    }),
  )
  writeFileSync(
    join(directory, "index.js"),
    `
    import { readFile, writeFile } from "node:fs/promises";
    export const inject = ["agents"];
    export function apply(ctx) {
      let attempts = 0;
      const version = () => readFile(${JSON.stringify(versionFile)}, "utf8");
      const driver = {
        id: "cli-update-test", displayName: "CLI Update Test",
        features: {
          streaming: false, approvals: false, questions: false, plan: false,
          resume: false, fork: false, rollback: false, checkpoint: false,
          subagents: false, mcp: false, images: false, usage: false,
          modelCatalog: false, nativeSessionId: false,
        },
        async detect() {
          return { installed: true, version: await version(), authenticated: true, command: "fixture-cli" };
        },
        async prepareCliUpdate() {
          return {
            target: "fixture-cli", currentVersion: await version(), latestVersion: "2.0.0",
            available: (await version()) !== "2.0.0", reason: null, command: "fixture-cli update",
            verify: version,
            async run(runtime) {
              attempts += 1;
              runtime.onOutput("fixture updater attempt " + attempts + "\\n");
              if (attempts === 1) throw new Error("fixture update failure");
              await new Promise(resolve => setTimeout(resolve, 400));
              await writeFile(${JSON.stringify(versionFile)}, "2.0.0");
              runtime.onOutput("updated to 2.0.0\\n");
            },
          };
        },
        async createSession(input) {
          return { id: "fixture", threadId: input.threadId, cwd: input.cwd,
            nativeSessionId: null, permissionMode: "workspace-write", model: null };
        },
        async send() {}, async interrupt() {}, async dispose() {},
      };
      ctx.agents.register(driver);
      ctx.effect(() => () => ctx.agents.unregister(driver.id));
    }
  `,
  )
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({
      PIGCODE_PROFILE_DIR: profile,
      PIGCODE_UPDATE_API: url,
      PIGCODE_CLAUDE_PATH: join(directory, "missing-claude"),
      PIGCODE_CODEX_PATH: join(directory, "missing-codex"),
    }),
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedUrls: opened })
      shell.openExternal = async (target: string) => {
        opened.push(target)
      }
    })
    await page.getByRole("button", { name: "插件", exact: true }).first().click()
    await installPlugin(page, directory)
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "Agent", exact: true }).first().click()
    const rowUpdate = page.getByRole("button", { name: "查看 CLI Update Test 的更新", exact: true })
    await rowUpdate.click()
    const center = page.locator(".update-center-popup")
    const cliRow = center.locator('[data-update-target="fixture-cli"]')
    await expect(cliRow).toHaveAttribute("data-focused", "true")
    await expect(cliRow).toContainText("1.0.0 → 2.0.0")
    await expect(center.locator('[data-update-target="app"]')).toContainText("9.9.9")
    await page.screenshot({
      animations: "disabled",
      path: "test-results/unified-updates-light.png",
    })
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.screenshot({ animations: "disabled", path: "test-results/unified-updates-dark.png" })
    await page.emulateMedia({ colorScheme: "light" })
    await center.getByRole("button", { name: "下载页", exact: true }).click()
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls),
      )
      .toEqual(["https://github.com/pigcode/pigcode/releases/tag/v9.9.9"])
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "打开 CLI Update Test 的设置" }).click()
    const update = page.locator(".agent-cli-version")
    await expect(update.locator(".agent-cli-value")).toHaveText("1.0.0")
    await expect(update.getByRole("button", { name: "更新 CLI", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "检查 CLI 更新", exact: true })).toHaveCount(0)
    await update.getByRole("button", { name: "更新 CLI", exact: true }).click()
    await expect(update).toContainText("CLI 更新失败")
    expect(readFileSync(versionFile, "utf8")).toBe("1.0.0")
    await update.getByRole("button", { name: "更新命令与日志" }).click()
    const details = page.locator(".agent-cli-popup")
    await expect(details.getByRole("alert")).toContainText("fixture update failure")
    await expect(details.locator("pre")).toContainText("attempt 1")
    await page.keyboard.press("Escape")

    await rowUpdate.click()
    await expect(cliRow).toContainText("CLI 更新失败")
    await cliRow.getByRole("button", { name: "重试", exact: true }).click()
    await expect(cliRow).toContainText("更新完成")
    await cliRow.locator(".update-center-summary").click()
    await expect(cliRow.locator("pre")).toContainText("updated to 2.0.0")
    await page.keyboard.press("Escape")
    await expect(update.locator(".agent-cli-value")).toHaveText("2.0.0")
    await update.getByRole("button", { name: "更新命令与日志" }).click()
    await expect(details.locator("pre")).toContainText("updated to 2.0.0")
    await page.keyboard.press("Escape")
    expect(readFileSync(versionFile, "utf8")).toBe("2.0.0")
    await page.screenshot({ animations: "disabled", path: "test-results/cli-update-completed.png" })
    await expect(page.getByRole("button", { name: "更新全部 CLI", exact: true })).toHaveCount(0)
    await expect(rowUpdate).toHaveCount(0)
    const indicator = page
      .locator(".window-controls")
      .getByRole("button", { name: "查看更新", exact: true })
    await expect(indicator).toHaveAttribute("title", "1 项更新可用")
    await indicator.click()
    await expect(cliRow).toHaveCount(0)
    await expect(center.locator('[data-update-target="app"]')).toBeVisible()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click()
    await indicator.click()
    await expect(center).toBeVisible()
    const bounds = await center.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
    await page.screenshot({
      animations: "disabled",
      path: "test-results/unified-updates-collapsed.png",
    })
  } finally {
    await app.close()
    server.close()
    rmSync(directory, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

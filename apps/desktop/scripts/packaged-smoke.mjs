/**
 * 实验（pigcode/pigcode#15）：启动打包后的应用，逐项检查 Host、原生模块、协议和插件。
 * 用法：node scripts/packaged-smoke.mjs <可执行文件路径>
 * 只记录问题，不修；结果写到 /tmp/packaged-smoke.json。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { _electron as electron } from "@playwright/test"

const executable = process.argv[2]
if (!executable) throw new Error("usage: node scripts/packaged-smoke.mjs <executable>")

const profile = "/tmp/pigcode-packaged-profile"
const project = "/tmp/pigcode-packaged-project"
const hostLog = "/tmp/pigcode-packaged-host.log"
const result = { executable, checks: {}, errors: [] }

rmSync(profile, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })
rmSync(hostLog, { force: true })
mkdirSync(join(project, "src"), { recursive: true })
writeFileSync(join(project, "README.md"), "# Packaged demo\n")
writeFileSync(join(project, "src/index.ts"), "export const answer = 42\n")

const app = await electron.launch({
  executablePath: executable,
  env: {
    ...process.env,
    PIGCODE_PROFILE_DIR: profile,
    PIGCODE_DB_PATH: ":memory:",
    PIGCODE_HOST_LOG: hostLog,
  },
})

const page = await app.firstWindow()
page.on("console", (message) => {
  if (/error|refused|violat/i.test(message.text())) result.errors.push(message.text())
})
page.on("pageerror", (error) => result.errors.push(error.message))

async function check(name, run) {
  try {
    await run()
    result.checks[name] = "ok"
  } catch (error) {
    result.checks[name] = `failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

await check("renderer loads", async () => {
  await page.waitForSelector(".app", { timeout: 30_000 })
})
await check("preload bridge", async () => {
  const bridge = await page.evaluate(() => typeof window.pigcodeNative?.previewOpen)
  if (bridge !== "function") throw new Error(`pigcodeNative missing (${bridge})`)
})
await check("create project and thread", async () => {
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByRole("button", { name: "添加项目" }).first().click()
  await page.getByRole("button", { name: "选择文件夹" }).click()
  await page.getByRole("button", { name: "创建项目", exact: true }).click()
  await page
    .locator(".proj-block")
    .filter({ hasText: "pigcode-packaged-project" })
    .locator(".proj-add")
    .click()
  await page.locator(".tiptap").waitFor({ timeout: 15_000 })
})
await check("read a file through the Host", async () => {
  await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
  await page.getByLabel("打开一个面板").getByRole("button", { name: /文件/ }).click()
  await page.keyboard.press("Escape")
  await page
    .locator('.files-surface [role="treeitem"]')
    .filter({ hasText: /^README\.md/ })
    .click()
  await page.locator(".file-surface .code-line").first().waitFor({ timeout: 15_000 })
})
await check("open a terminal", async () => {
  await page.getByRole("button", { name: "添加面板" }).click()
  await page.getByRole("menuitem", { name: /终端/ }).click()
  await page.locator(".xterm").first().waitFor({ timeout: 15_000 })
})
await check("install a generated plugin", async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "插件", exact: true }).first().click()
  await page.locator(".page-head").getByRole("button", { name: "安装插件" }).click()
  const dialog = page.getByRole("dialog", { name: "安装插件" })
  await dialog.getByLabel("插件目录或 npm 包").fill("/tmp/pigcode-packaged-plugin")
  await dialog.getByRole("button", { name: "安装", exact: true }).click()
  try {
    await dialog.waitFor({ state: "hidden", timeout: 30_000 })
  } catch {
    const text = await dialog.textContent().catch(() => "")
    throw new Error(`install dialog stayed open: ${(text ?? "").slice(0, 500)}`)
  }
  await page.getByText("packaged-demo").first().waitFor({ timeout: 15_000 })
})

writeFileSync("/tmp/packaged-smoke.json", JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await app.close()

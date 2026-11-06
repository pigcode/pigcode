/**
 * 打包后的应用冒烟（pigcode/pigcode#69）：启动安装后的应用，而不是构建产物。
 * 打包后才会坏的东西只能在这里发现：原生模块、asar、插件安装、License 文件。
 *
 * 跑法：先在 apps/desktop 里 `pnpm package:mac`（其他平台用对应的脚本），再 `pnpm test:packaged`。
 * macOS 会把 .app 复制到临时目录再启动：在仓库里运行打包后的应用时，Node 会顺着目录往上找到
 * 工作区的依赖，测试就变成假通过。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test"
import { addProject, installPlugin, launchEnv } from "./projects"

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, "../dist")

/** 打包产物的位置：环境变量优先，否则按平台找 electron-builder 的输出。 */
function packagedExecutable(): string | undefined {
  const fromEnv = process.env.PIGCODE_PACKAGED_APP
  if (fromEnv) return fromEnv
  const candidates =
    process.platform === "darwin"
      ? [
          join(distDir, "mac-arm64/Pigcode.app/Contents/MacOS/Pigcode"),
          join(distDir, "mac/Pigcode.app/Contents/MacOS/Pigcode"),
        ]
      : process.platform === "win32"
        ? [join(distDir, "win-unpacked/Pigcode.exe")]
        : [join(distDir, "linux-unpacked/pigcode")]
  return candidates.find((path) => existsSync(path))
}

/** macOS 上可执行文件在 .app 里面；其他平台直接就是文件。 */
function appBundleOf(executable: string): string | undefined {
  const marker = `${join("Contents", "MacOS")}`
  const index = executable.indexOf(marker)
  return index > 0 ? executable.slice(0, index - 1) : undefined
}

/** 把 .app 复制到临时目录，返回新的可执行文件路径。 */
function copyOutsideRepo(executable: string, dir: string): string {
  const bundle = appBundleOf(executable)
  if (!bundle) return executable
  const target = join(dir, "Pigcode.app")
  // 必须原样保留符号链接：Node 默认会按目标重写链接，Framework 里的 icudtl.dat 就找不到了。
  cpSync(bundle, target, { recursive: true, verbatimSymlinks: true })
  return join(target, executable.slice(bundle.length + 1))
}

/** 安装包里的许可证文件：MIT 要求随分发保留，架构文档 §15 要求保留 Cordis 和 dsh 的声明。 */
function resourcesDirOf(executable: string): string {
  const bundle = appBundleOf(executable)
  if (bundle) return join(bundle, "Contents", "Resources")
  // Windows 和 Linux 的 unpacked 目录里，extraResources 就在可执行文件旁边。
  return join(dirname(executable), "resources")
}

/**
 * 一个指向源码的插件：manifest 的 `main` 是 .ts。
 * 安装包里不带编译器，装它必须失败——用它验证「复制到仓库外面」确实把工作区的依赖隔开了。
 */
function sourcePlugin(workspace: string): string {
  const dir = join(workspace, "source-plugin")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "pigcode-source-plugin",
      version: "1.0.0",
      type: "module",
      main: "./index.ts",
      pigcode: { apiVersion: 1, kind: "capability", host: "./index.ts" },
    }),
  )
  writeFileSync(join(dir, "index.ts"), "export function apply(): void {}\n")
  return dir
}

test("the packaged app still chats, installs a plugin and runs a terminal", async () => {
  const executable = packagedExecutable()
  // 显式跑 test:packaged 时没有安装包就是失败，不能静默跳过；普通 E2E 里跳过它。
  const expected =
    process.env.npm_lifecycle_event === "test:packaged" ||
    process.env.PIGCODE_PACKAGED_EXPECTED === "1"
  if (expected) {
    expect(executable, "build the app first (pnpm package:mac)").toBeTruthy()
  } else {
    test.skip(!executable, "build the app first (pnpm package:mac) or set PIGCODE_PACKAGED_APP")
  }
  test.setTimeout(300_000)

  const dir = mkdtempSync(join(tmpdir(), "pigcode-packaged-"))
  const workspace = join(dir, "workspace")
  mkdirSync(join(workspace, "src"), { recursive: true })
  writeFileSync(join(workspace, "README.md"), "# Packaged\n")
  writeFileSync(join(workspace, "src/index.ts"), "export const answer = 42\n")
  const profile = join(dir, "profile")

  // 插件用构建好的样例：安装包里没有编译器，源码插件本来就装不上（ADR 0006）。
  const example = resolve(here, "../../../examples/capability-clock")
  const plugin = join(workspace, "capability-clock")
  cpSync(example, plugin, {
    recursive: true,
    filter: (path) => !path.includes("node_modules"),
  })

  const resources = resourcesDirOf(executable!)
  expect(existsSync(join(resources, "LICENSE.txt"))).toBe(true)
  expect(existsSync(join(resources, "THIRD_PARTY_NOTICES.txt"))).toBe(true)

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      executablePath: copyOutsideRepo(executable!, dir),
      args: [],
      cwd: workspace,
      env: {
        // 终端用系统的 shell；Linux 的 CI/容器里不一定设了 SHELL。
        ...launchEnv({
          PIGCODE_AGENT: "fake",
          PIGCODE_PROFILE_DIR: profile,
          SHELL: process.platform === "win32" ? "" : "/bin/sh",
        }),
        PIGCODE_HOST_LOG: join(dir, "host.log"),
      },
    })
    const page = await app.firstWindow()

    // 会话能开、能流式回答。
    await addProject(app, page, workspace)
    await page.locator(".proj-block").filter({ hasText: "workspace" }).locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Hello from fake agent")).toBeVisible({ timeout: 15_000 })

    // 插件：构建好的包能装、能启用。
    await page.getByRole("button", { name: "插件" }).first().click()
    await installPlugin(page, plugin)
    await expect(
      page.locator(".ext-item").filter({ hasText: "pigcode-capability-clock" }),
    ).toBeVisible()

    // 安装包里没有 esbuild（ADR 0006），源码插件要被明确拒绝，而不是崩掉或静默失败。
    // 这一条同时证明「复制到仓库外面」是有效的：在仓库里跑时 Node 会找到工作区的 esbuild，
    // 源码插件会装成功，这条断言就会失败。安装失败时对话框不会关，所以不能走 installPlugin。
    const dialog = page.getByRole("dialog", { name: "安装插件" })
    await page.locator(".page-head").getByRole("button", { name: "安装插件" }).click()
    await dialog.getByLabel("插件目录或 npm 包").fill(sourcePlugin(workspace))
    await dialog.getByRole("button", { name: "安装", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("不带编译器")
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()

    // 终端：node-pty 在安装包里能加载。
    await page.getByRole("button", { name: "返回应用" }).first().click()
    await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
    await page.getByLabel("打开一个面板").getByRole("button", { name: /终端/ }).click()
    await expect(page.locator(".xterm")).toBeVisible()
    await page.locator(".xterm").click()
    await page.keyboard.type("echo PACKAGED-READY")
    await page.keyboard.press("Enter")
    await expect(page.locator(".xterm")).toContainText("PACKAGED-READY")

    // 退出：窗口和 Host 一起走。
    await app.close()
    app = undefined
  } finally {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

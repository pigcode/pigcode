/** 多主机全链路 Electron E2E 验收：真实启动第二台 headless Host、配对核对码、Orca 混排/分主机、远程目录与对话、定时任务、Paseo 分域设置与远端撤销。 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test } from "@playwright/test"
import { buildHeadlessHost } from "../../../scripts/build-headless-host"
import { callAdminSocket } from "../../host/src/kernel/admin-socket"
import { backFromSettings, launchArgs, launchEnv } from "./projects"

const HEADLESS_CLI = fileURLToPath(
  new URL("../../host/out/headless/bin/pigcode.mjs", import.meta.url),
)

interface StartedHostHandle {
  socketPath: string
  stop: () => Promise<void>
}

async function startHeadlessHostProcess(profileDir: string): Promise<StartedHostHandle> {
  if (!existsSync(HEADLESS_CLI)) {
    await buildHeadlessHost()
  }
  const child = spawn(
    process.execPath,
    [
      HEADLESS_CLI,
      "--profile-dir",
      profileDir,
      "start",
      "--lan-port",
      "0",
      "--no-shell-env",
      "--json",
    ],
    {
      env: launchEnv({
        PIGCODE_PROFILE_DIR: profileDir,
        PIGCODE_DB_PATH: join(profileDir, "headless.db"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const socketPath = await new Promise<string>((resolve, reject) => {
    let buffer = ""
    let stderr = ""
    const timer = setTimeout(() => {
      reject(new Error(`headless pigcode start timed out; stderr=${stderr}`))
    }, 20_000)

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as {
            event?: string
            socketPath?: string
            message?: string
          }
          if (parsed.event === "started" && parsed.socketPath) {
            clearTimeout(timer)
            resolve(parsed.socketPath)
            return
          }
          if (parsed.event === "error") {
            clearTimeout(timer)
            reject(new Error(parsed.message || "headless host failed to start"))
            return
          }
        } catch {
          // ignore non-json log line
        }
      }
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`headless host exited early (${code}); stderr=${stderr}`))
    })
  })

  return {
    socketPath,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 5_000)
        child.once("exit", () => {
          clearTimeout(killTimer)
          resolve()
        })
      })
    },
  }
}

test("connects desktop to real headless host end-to-end across Orca workspace and Paseo scoped settings", async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), "pigcode-e2e-multihost-"))
  const desktopProfile = join(root, "desktop-profile")
  const remoteProfile = join(root, "remote-profile")
  const remoteRepo = join(root, "remote-proj")
  mkdirSync(desktopProfile, { recursive: true })
  mkdirSync(remoteProfile, { recursive: true })
  mkdirSync(join(remoteRepo, "src"), { recursive: true })
  writeFileSync(join(remoteRepo, "README.md"), "# Remote Multi-Host Repo\n")
  writeFileSync(join(remoteRepo, "src/main.ts"), "export const remote = true\n")

  const headless = await startHeadlessHostProcess(remoteProfile)
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({
      PIGCODE_PROFILE_DIR: desktopProfile,
    }),
  })

  try {
    const page = await app.firstWindow()

    // 1. 工作区侧栏仅含「新会话 + 定时任务」（无顶栏「插件」）。
    const sideActions = page.locator(".side-actions")
    await expect(sideActions.getByRole("button", { name: "新会话" })).toBeVisible()
    await expect(sideActions.getByRole("button", { name: "定时任务", exact: true })).toBeVisible()
    await expect(sideActions.getByRole("button", { name: "插件", exact: true })).toHaveCount(0)

    // 2. 打开「设置 → 远程主机」：顶部为「共享当前本机」，生成本机共享链接。
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.locator(".sidebar").getByRole("button", { name: "远程主机", exact: true }).click()
    await expect(page.getByText("共享当前本机", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "生成共享链接", exact: true }).click()
    await expect(page.locator(".host-link-code")).toContainText("pigcode://pair?")
    await page.getByRole("button", { name: "取消共享", exact: true }).click()

    // 3. 在真实 headless Host 侧发起 desktop 配对链接，并在本机弹窗接入 + 核对 6 位验证码确认。
    const started = await callAdminSocket(headless.socketPath, "desktop.pairing.start", {})
    expect(started.attempt?.link).toContain("pigcode://pair?")

    await page.getByRole("button", { name: "添加远程主机", exact: true }).click()
    const addDialog = page.getByRole("dialog", { name: "添加远程主机" })
    await addDialog.getByLabel("桌面端共享链接（pigcode://pair?...）").fill(started.attempt!.link!)
    await addDialog.getByLabel("自定义名称（可选）").fill("Studio Linux")
    await addDialog.getByRole("radio", { name: "琥珀" }).click()
    await addDialog.getByRole("button", { name: "连接并校验", exact: true }).click()

    const digits = addDialog.locator(".host-verify-digits")
    await expect(digits).toBeVisible()
    const desktopCode = (await digits.textContent())?.trim()

    let candidateConfirmation = ""
    let remoteCode = ""
    await expect
      .poll(async () => {
        const view = await callAdminSocket(headless.socketPath, "desktop.pairing.view", {})
        if (view.status === "verify" && view.attempt?.candidate) {
          candidateConfirmation = view.attempt.candidate.confirmation
          remoteCode = view.attempt.candidate.code
          return true
        }
        return false
      })
      .toBe(true)
    expect(remoteCode).toBe(desktopCode)

    await callAdminSocket(headless.socketPath, "desktop.pairing.confirm", {
      id: started.attempt!.id,
      confirmation: candidateConfirmation,
    })
    await expect(addDialog).toBeHidden()
    await expect(page.getByText("Studio Linux", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/无头主机.*在线.*局域网直连/)).toBeVisible()

    // 4. 返回工作区：通过「添加远程主机文件夹」浏览远端目录并创建远程项目，验证 Orca 混排/按主机切换。
    await backFromSettings(page)
    await expect(page.locator(".side-foot-cluster")).toContainText("主机 · 2/2")
    await page.getByRole("button", { name: "添加项目" }).first().click()
    const projDialog = page.getByRole("dialog", { name: "添加项目" })
    await projDialog.getByRole("button", { name: "运行主机" }).click()
    await page.getByRole("menuitemradio", { name: /Studio Linux/ }).click()
    const remotePath = projDialog.getByPlaceholder("/path/to/project")
    await remotePath.fill(remoteRepo)
    await remotePath.press("Enter")
    await expect(projDialog.locator(".remote-dir-item").filter({ hasText: "src" })).toBeVisible()
    await projDialog.getByRole("button", { name: "添加", exact: true }).click()
    await expect(projDialog).toBeHidden()

    const sidebar = page.locator(".sidebar")
    const projBlock = sidebar.locator(".proj-block").filter({ hasText: "remote-proj" })
    await expect(projBlock.locator(".host-chip")).toContainText("Studio Linux")

    await sidebar.getByRole("button", { name: "按主机", exact: true }).click()
    await expect(
      sidebar.locator(".side-host-group").filter({ hasText: "Studio Linux" }),
    ).toBeVisible()
    await sidebar.getByRole("button", { name: "混排", exact: true }).click()

    // 5. 在远程项目发起真实对话，并在工作台验证目标主机标识与禁用的本机访达入口。
    await projBlock.locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await page.getByRole("textbox").fill("hello multi-host")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Hello from fake agent")).toBeVisible()

    await page.locator(".panel-top").getByRole("button", { name: "显示或隐藏右侧面板" }).click()
    await expect(page.locator(".workbench-host-pill")).toContainText("Studio Linux")
    await expect(page.locator(".open-in-split")).toHaveCount(0)
    await page.getByRole("button", { name: "会话详情", exact: true }).click()
    await expect(page.getByRole("button", { name: "复制路径", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")

    // 6. 定时任务：跨主机列表与新建选机。
    await sideActions.getByRole("button", { name: "定时任务", exact: true }).click()
    await page
      .locator(".schedules .page-head")
      .getByRole("button", { name: "新建任务", exact: true })
      .click()
    await page.locator(".schedule-editor").getByRole("button", { name: "运行主机" }).click()
    await page.getByRole("menuitemradio", { name: /Studio Linux/ }).click()
    await page.getByLabel("名字", { exact: true }).fill("远端每日检查")
    await page.getByRole("textbox", { name: "要做什么", exact: true }).fill("Check remote host")
    await page.getByRole("button", { name: "创建任务", exact: true }).click()
    const schedCard = page.locator(".schedule-card").filter({ hasText: "远端每日检查" })
    await expect(schedCard.locator(".host-chip")).toContainText("Studio Linux")

    // 7. 设置 Paseo 主机作用域切换：验证远程插件隔离提示与防休眠仅限本机，随后在远端撤销桌面端授权。
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.locator(".settings-scope-trigger").click()
    await page.getByRole("menuitemradio", { name: /Studio Linux/ }).click()
    await page.locator(".sidebar").getByRole("button", { name: "插件", exact: true }).click()
    await expect(page.getByText(/桌面端界面渲染插件仅从受信任的本机加载执行/)).toBeVisible()
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "守护进程、中继与识别色", exact: true })
      .click()
    await expect(page.getByText(/防休眠仅控制当前桌面客户端所在主机/)).toBeVisible()

    const desktopClients = await callAdminSocket(headless.socketPath, "desktop.devices.list", {})
    expect(desktopClients).toHaveLength(1)
    await callAdminSocket(headless.socketPath, "desktop.devices.revoke", {
      deviceId: desktopClients[0]!.id,
    })

    await page.locator(".sidebar").getByRole("button", { name: "远程主机", exact: true }).click()
    await expect(page.getByText(/已被远端撤销/)).toBeVisible()
    await backFromSettings(page)
    await expect(page.locator(".side-foot-cluster")).toContainText("主机 · 1/2")
  } finally {
    await app.close()
    await headless.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 打包后的「下载完整包」（pigcode/monorepo#71）：macOS 的升级链路在真安装包里走完。
 *
 * 只测打包后才成立的那一段——开发运行时 isPackaged 为 false，换包逻辑整个不启动，
 * 单元测试覆盖不到：Release 的 assets 能不能一路传到挑 DMG 的地方、下载是不是真的
 * 落进 userData。之前的 bug 正是 assets 在中途丢了，只剩永远走下载页。
 *
 * 不真的下载几百兆：GitHub API 和附件下载都指向本地假服务；对话框和「打开安装包」
 * 用桩代替，避免 CI 上没有窗口管理器时卡在 Finder 上。userData 用 --user-data-dir
 * 指到临时目录，不碰运行测试的人自己的数据。
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, expect, test } from "@playwright/test"
import { launchEnv } from "./projects"

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, "../dist")

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

/** 假的 DMG 内容：真包几百兆，这里只要证明字节原样落地。 */
const DMG_BYTES = Buffer.from("fake dmg payload")

/**
 * 假 GitHub：`/releases` 返回带 assets 的列表，`/download/*` 返回假 DMG。
 * 两个架构都列上，用来验证挑的是当前架构那一个。
 */
async function fakeGithub(version: string): Promise<{ api: string; server: Server }> {
  let origin = ""
  const server = createServer((request, response) => {
    if (request.url === "/releases") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          {
            tag_name: `v${version}`,
            html_url: `https://github.com/pigcode/pigcode/releases/tag/v${version}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `Pigcode-${version}-arm64.dmg`,
                browser_download_url: `${origin}/download/Pigcode-${version}-arm64.dmg`,
              },
              {
                name: `Pigcode-${version}.dmg`,
                browser_download_url: `${origin}/download/Pigcode-${version}.dmg`,
              },
            ],
          },
        ]),
      )
      return
    }
    if (request.url?.startsWith("/download/")) {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(DMG_BYTES)
      return
    }
    response.writeHead(404).end("not found")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${String(port)}`
  return { api: `${origin}/releases`, server }
}

test("the packaged app downloads the dmg for its architecture", async () => {
  test.skip(process.platform !== "darwin", "only macOS replaces the app package")
  const executable = packagedExecutable()
  const expected =
    process.env.npm_lifecycle_event === "test:packaged" ||
    process.env.PIGCODE_PACKAGED_EXPECTED === "1"
  if (expected) {
    expect(executable, "build the app first (pnpm package:mac)").toBeTruthy()
  } else {
    test.skip(!executable, "build the app first (pnpm package:mac) or set PIGCODE_PACKAGED_APP")
  }
  test.setTimeout(180_000)

  const version = "9.9.9"
  const { api, server } = await fakeGithub(version)
  const dir = mkdtempSync(join(tmpdir(), "pigcode-packaged-update-"))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      executablePath: executable!,
      // 打包后的应用不认 PIGCODE_PROFILE_DIR，用 Electron 自己的开关把 userData 挪到临时目录。
      args: ["--lang=zh-CN", `--user-data-dir=${join(dir, "userData")}`],
      env: launchEnv({ PIGCODE_UPDATE_API: api }),
    })
    await app.firstWindow()

    // 对话框一律选第一个按钮（「打开安装包」），并把要打开的路径记下来。
    await app.evaluate(({ dialog, shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { openedPaths: opened })
      dialog.showMessageBox = (async (
        windowOrOptions: unknown,
        maybeOptions?: { message: string },
      ) => {
        const options = maybeOptions ?? (windowOrOptions as { message: string })
        Object.assign(globalThis, { lastMessage: options.message })
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      shell.openPath = (async (target: string) => {
        opened.push(target)
        // 空串表示成功；返回错误字符串会走「打不开，退回下载页」那条路。
        return ""
      }) as typeof shell.openPath
    })
    const userData = await app.evaluate(({ app }) => app.getPath("userData"))
    // --user-data-dir 生效了才说明不会写进本机真实的用户目录。
    // macOS 上 /var 是指向 /private/var 的符号链接，两边都取真实路径再比。
    expect(realpathSync(userData)).toBe(realpathSync(join(dir, "userData")))

    // 启动后 5 秒的第一次后台检查会触发下载；手动检查只回报结果，不走这条路。
    const openedPaths = (): Promise<string[]> =>
      app!.evaluate(() => (globalThis as unknown as { openedPaths: string[] }).openedPaths)
    await expect.poll(openedPaths, { timeout: 90_000 }).toHaveLength(1)

    const [packagePath] = await openedPaths()
    expect(packagePath).toBe(join(userData, "update-downloads", `Pigcode-${version}-arm64.dmg`))
    // 真的下载了，字节和假服务给的一致。
    expect(readFileSync(packagePath!).equals(DMG_BYTES)).toBe(true)

    const message = await app.evaluate(
      () => (globalThis as unknown as { lastMessage?: string }).lastMessage,
    )
    expect(message).toBe(`新版本 ${version} 已下载`)
  } finally {
    await app?.close()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

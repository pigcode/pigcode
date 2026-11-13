/** 用 Echo 生成 Markdown 链接，验证原生菜单和打开、复制与下载。 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication } from "@playwright/test"
import { startDemoSite } from "./demo-site"
import { installPlugin, openThread } from "./projects"

test("assistant links open in the system browser and offer the desktop link menu", async () => {
  const site = await startDemoSite()
  const dir = mkdtempSync(join(tmpdir(), "pigcode-link-download-"))
  const download = join(dir, "demo.html")
  let app: ElectronApplication | undefined
  try {
    const { app: electronApp, page } = await openThread("chat-links", { PIGCODE_AGENT: "echo" })
    app = electronApp
    await page.locator(".side-actions").getByRole("button", { name: "插件", exact: true }).click()
    const echo = new URL("../../../examples/agent-echo", import.meta.url).pathname
    await installPlugin(page, echo)
    await page.getByRole("button", { name: "新会话" }).first().click()
    await app.evaluate(
      ({ Menu, session, shell }, { url, download }) => {
        const opened: string[] = []
        const linkMenu = {
          labelToSelect: null as string | null,
          items: [] as Array<{ label: string; enabled: boolean; type: string }>,
          popups: 0,
        }
        Object.assign(globalThis, { openedUrls: opened, linkMenu })
        shell.openExternal = async (target) => {
          opened.push(target)
        }
        // Playwright 不操作系统菜单，在原生弹出入口记录实际生成的菜单并模拟选中。
        Menu.prototype.popup = function (this: InstanceType<typeof Menu>, options) {
          linkMenu.items = this.items.map(({ label, enabled, type }) => ({ label, enabled, type }))
          linkMenu.popups += 1
          this.items
            .find(({ label, enabled }) => enabled && label === linkMenu.labelToSelect)
            ?.click({}, options?.window)
          options?.callback?.()
        }
        // Electron 的原生保存对话框无法由 Playwright 点击，用临时路径代替用户选择。
        session.fromPartition("persist:pigcode-browser").on("will-download", (_event, item) => {
          if (item.getURL() === url) item.setSavePath(download)
        })
      },
      { url: site.url, download },
    )
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => Object.assign(window, { copiedChatLink: text }),
      })
    })

    const composer = page.locator(".tiptap")
    await composer.fill(`[打开 Demo](${site.url})`)
    await composer.press("Enter")
    const link = page.locator(".msg-ai").getByRole("link", { name: "打开 Demo" })
    const externalUrls = () =>
      electronApp.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls)
    await link.click()
    await expect.poll(externalUrls).toEqual([site.url])

    const nativeMenu = () =>
      electronApp.evaluate(
        () =>
          (
            globalThis as unknown as {
              linkMenu: {
                items: Array<{ label: string; enabled: boolean; type: string }>
                popups: number
              }
            }
          ).linkMenu,
      )
    async function choose(name: string | null): Promise<void> {
      const { popups } = await nativeMenu()
      await electronApp.evaluate((_, label) => {
        const { linkMenu } = globalThis as unknown as { linkMenu: { labelToSelect: string | null } }
        linkMenu.labelToSelect = label
      }, name)
      await link.click({ button: "right" })
      await expect.poll(async () => (await nativeMenu()).popups).toBe(popups + 1)
    }
    await choose(null)
    const { items } = await nativeMenu()
    expect(
      items
        .filter((item) => item.type !== "separator")
        .map(({ label, enabled }) => [label, enabled]),
    ).toEqual([
      ["在以下位置打开", false],
      ["新标签页", true],
      ["默认浏览器", true],
      ["复制链接", true],
      ["链接另存为…", true],
    ])
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect.poll(externalUrls).toEqual([site.url])

    await choose("默认浏览器")
    await expect.poll(externalUrls).toEqual([site.url, site.url])
    await choose("复制链接")
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { copiedChatLink?: string }).copiedChatLink),
      )
      .toBe(site.url)

    await choose("新标签页")
    await expect(page.locator(".browser-address input")).toHaveValue(site.url)
    await expect(page.getByRole("tab", { name: "Demo 登录" })).toBeVisible()

    await choose("链接另存为…")
    await expect
      .poll(() => {
        try {
          return readFileSync(download, "utf8")
        } catch {
          return ""
        }
      })
      .toContain("登录 Demo")
  } finally {
    await app?.close()
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

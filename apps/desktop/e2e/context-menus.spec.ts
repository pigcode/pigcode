/** 验证右键按所点对象选择菜单；拦截 Electron 弹窗以检查系统菜单收到的内容。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

interface ObservedMenu {
  labels: Array<string | undefined>
  roles: Array<string | undefined>
  x: number
  y: number
}

test("right-clicks route to the text, sidebar and workbench tab menus", async () => {
  const { app, page } = await openThread("context-menus")
  try {
    await app.evaluate(({ Menu }) => {
      const observed: ObservedMenu[] = []
      Object.assign(globalThis, { observedContextMenus: observed })
      Menu.buildFromTemplate = (template) =>
        ({
          popup(options: { x: number; y: number; callback?: () => void }) {
            observed.push({
              x: options.x,
              y: options.y,
              labels: template.map((item) => item.label),
              roles: template.map((item) => item.role),
            })
            options.callback?.()
          },
        }) as ReturnType<typeof Menu.buildFromTemplate>
    })
    const menus = () =>
      app.evaluate(
        () => (globalThis as { observedContextMenus?: ObservedMenu[] }).observedContextMenus ?? [],
      )

    const composer = page.locator(".tiptap")
    await composer.fill("Context menu sample")
    await composer.click({ button: "right", position: { x: 12, y: 10 } })
    await expect
      .poll(async () => (await menus())[0]?.roles.filter(Boolean))
      .toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"])

    await composer.press("Enter")
    const reply = page.locator(".msg-ai p").filter({ hasText: "Hello from fake agent" })
    await expect(reply).toBeVisible()
    await reply.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await reply.click({ button: "right", position: { x: 12, y: 8 } })
    await expect.poll(async () => (await menus())[1]?.roles).toEqual(["copy"])

    await page.locator(".proj-block .proj").first().click({ button: "right" })
    await expect
      .poll(async () => (await menus())[2]?.labels.filter(Boolean))
      .toEqual(["重命名", expect.stringMatching(/^在.+中打开$/), "从侧栏移除"])
    await page.locator(".sess").first().click({ button: "right" })
    await expect.poll(async () => (await menus())[3]?.labels).toEqual(["重命名", "归档"])

    await page.locator(".panel-top").getByRole("button", { name: "切换右侧面板" }).click()
    await page
      .getByLabel("打开一个面板")
      .getByRole("button", { name: /浏览器/ })
      .click()
    const browser = page.getByRole("tab", { name: "浏览器" })
    await expect(browser).toBeVisible()
    const tab = await browser.boundingBox()
    expect(tab).not.toBeNull()
    await browser.click({ button: "right", position: { x: 12, y: 10 } })
    await expect
      .poll(async () => (await menus())[4]?.labels)
      .toEqual(["关闭标签", "关闭其他标签", "关闭所有标签"])
    const menu = (await menus())[4]!
    expect(Math.abs(menu.x - tab!.x - 12)).toBeLessThanOrEqual(2)
    expect(Math.abs(menu.y - tab!.y - 10)).toBeLessThanOrEqual(2)
  } finally {
    await app.close()
  }
})

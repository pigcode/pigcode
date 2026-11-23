/**
 * 侧栏的状态、未读与筛选走真的 Host：后台跑完的会话标成未读，按状态分组时排在「需要处理」，
 * 打开它就变成已读；归档的会话只在「已归档」里，取消归档后回到列表。
 */
import { expect, test, type Page } from "@playwright/test"
import { openThread, pickNextMenuItem } from "./projects"

const PROJECT = "pigcode-e2e-sidebar-filters"

function row(page: Page, title: string) {
  return page.locator(".sess").filter({ hasText: title })
}

/** 在当前会话里发一条消息，等它出现在时间线里。 */
async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox").click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect(page.locator(".msg-user").filter({ hasText: text })).toBeVisible()
}

/** 在「自定义侧栏」菜单里点一项；子菜单里的项先打开它的子菜单。 */
async function customize(page: Page, submenu: RegExp | null, item: string): Promise<void> {
  await page.getByRole("button", { name: "自定义侧栏" }).click()
  if (submenu) await page.getByRole("menuitem", { name: submenu }).click()
  await page
    .getByRole("menuitemradio", { name: item })
    .or(page.getByRole("menuitemcheckbox", { name: item }))
    .click()
  await page.keyboard.press("Escape")
  if (submenu) await page.keyboard.press("Escape")
}

test("background results show as unread, sort into the status groups, and archived threads come back", async () => {
  // 并发压到 1：第一个会话跑 `long` 一直不结束，第二个会话排在后面；停掉第一个以后第二个在后台跑完。
  const { app, page } = await openThread("sidebar-filters", { PIGCODE_MAX_CONCURRENT_RUNS: "1" })
  try {
    await send(page, "long")
    await page.locator(".proj-block").filter({ hasText: PROJECT }).locator(".proj-add").click()
    await expect(page.locator(".tiptap")).toHaveAttribute("contenteditable", "true")
    await send(page, "second run")
    await expect(row(page, "second run")).toHaveAttribute("data-status", "queued")

    await row(page, "long").click()
    await page.getByRole("button", { name: "停下" }).click()
    await expect(row(page, "second run")).toHaveAttribute("data-status", "completed", {
      timeout: 20_000,
    })
    // 看着的是 long，second run 是在后台跑完的：亮着未读的绿点。
    await expect(row(page, "second run")).toHaveAttribute("data-unread", "")
    await expect(row(page, "long")).not.toHaveAttribute("data-unread", "")

    await customize(page, /^分组/, "状态")
    await expect(page.locator(".side-scroll .side-label > span").first()).toHaveText("需要处理")
    await expect(page.getByRole("group", { name: "需要处理" })).toContainText("second run")
    // 打开以后变成已读，但看着它的时候还留在「需要处理」。
    await row(page, "second run").click()
    await expect(row(page, "second run")).not.toHaveAttribute("data-unread", "")
    await expect(page.getByRole("group", { name: "需要处理" })).toContainText("second run")
    await row(page, "long").click()
    await expect(page.getByRole("group", { name: "已完成" })).toContainText("second run")
    await customize(page, /^分组/, "项目")

    await pickNextMenuItem(app, "归档")
    await row(page, "long").click({ button: "right" })
    await expect(row(page, "long")).toHaveCount(0)

    await customize(page, null, "已归档")
    await expect(page.getByRole("button", { name: "自定义侧栏" })).toHaveAttribute(
      "data-active",
      "",
    )
    await expect(row(page, "long")).toBeVisible()
    await expect(row(page, "second run")).toHaveCount(0)
    await pickNextMenuItem(app, "取消归档")
    await row(page, "long").click({ button: "right" })
    await expect(row(page, "long")).toHaveCount(0)

    await customize(page, null, "已归档")
    await expect(row(page, "long")).toBeVisible()
    await expect(row(page, "second run")).toBeVisible()
  } finally {
    await app.close()
  }
})

test("opens pinned threads first with the sidebar shortcut and clears their pin when archived", async () => {
  const { app, page } = await openThread("sidebar-pinning")
  const title = "pin smoke target"
  const pinned = page.getByRole("group", { name: "置顶", exact: true })
  try {
    await send(page, title)
    await page.locator(".proj-block").filter({ hasText: "pigcode-e2e-sidebar-pinning" })
      .locator(".proj-add").click()
    await send(page, "recent smoke thread")

    await pickNextMenuItem(app, "置顶")
    await row(page, title).click({ button: "right" })
    await expect(pinned).toContainText(title)
    await expect(row(page, title)).toHaveCount(1)
    await page.keyboard.press("ControlOrMeta+1")
    await expect(page.locator(".msg-user").filter({ hasText: title })).toBeVisible()

    await customize(page, /^分组/, "状态")
    await expect(page.locator(".side-scroll .side-label > span").first()).toHaveText("置顶")
    await expect(row(page, title)).toHaveCount(1)
    await page.keyboard.press("ControlOrMeta+k")
    await page.getByPlaceholder("搜索或输入命令").fill(title)
    await expect(page.getByRole("option", { name: new RegExp(title) })).toHaveCount(1)
    await page.keyboard.press("Escape")

    await pickNextMenuItem(app, "取消置顶")
    await row(page, title).click({ button: "right" })
    await expect(pinned).toHaveCount(0)
    await expect(row(page, title)).toBeVisible()
    await pickNextMenuItem(app, "置顶")
    await row(page, title).click({ button: "right" })
    await expect(pinned).toContainText(title)
    await pickNextMenuItem(app, "归档")
    await row(page, title).click({ button: "right" })
    await expect(pinned).toHaveCount(0)
    await customize(page, null, "已归档")
    await expect(row(page, title)).toBeVisible()
    await expect(pinned).toHaveCount(0)
    await pickNextMenuItem(app, "取消归档")
    await row(page, title).click({ button: "right" })
    await expect(row(page, title)).toHaveCount(0)
    await customize(page, null, "已归档")
    await customize(page, /^分组/, "项目")
    await expect(row(page, title)).toBeVisible()
    await expect(pinned).toHaveCount(0)
  } finally {
    await app.close()
  }
})

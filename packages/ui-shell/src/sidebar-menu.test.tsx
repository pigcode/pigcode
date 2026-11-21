/** 验证「自定义侧栏」菜单：按时间和按状态分组、显示项、未读、全部标为已读、只看已归档与重置筛选。 */
// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { chooseMenuItem, mockMenu, project, renderSidebar, thread } from "./sidebar.fixtures"

afterEach(() => {
  cleanup()
  window.localStorage.removeItem("pigcode.sidebarGrouping")
  window.localStorage.removeItem("pigcode.sidebarView")
  Reflect.deleteProperty(window, "pigcodeNative")
})

const titles = () =>
  Array.from(document.querySelectorAll(".sess-title")).map((node) => node.textContent)

/** 打开「自定义侧栏」菜单里的一个子菜单；菜单已经开着时直接点子菜单的入口。 */
async function openSubmenu(name: RegExp) {
  if (screen.queryAllByRole("menu").length === 0) {
    await userEvent.click(screen.getByRole("button", { name: "自定义侧栏" }))
  }
  await userEvent.click(await screen.findByRole("menuitem", { name }))
}

describe("sidebar menu", () => {
  it("groups threads into time buckets from the menu and shows their projects on a second line", async () => {
    const day = 86_400_000
    renderSidebar({
      projects: [project("p1", "alpha"), project("p2", "beta")],
      threads: [
        thread("t1", "p1", "older", new Date(Date.now() - 40 * day).toISOString()),
        thread("t2", "p2", "newest", new Date().toISOString()),
        thread("t3", "p1", "middle", new Date(Date.now() - 60_000).toISOString()),
        thread("t4", "gone", "hidden", new Date().toISOString()),
      ],
    })
    // 按项目分组时组里也是新的在上面。
    expect(titles()).toEqual(["middle", "older", "newest"])

    await openSubmenu(/^分组/)
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "更新时间" }))
    expect(window.localStorage.getItem("pigcode.sidebarGrouping")).toBe("time")
    expect(titles()).toEqual(["newest", "middle", "older"])
    const today = screen.getByRole("group", { name: "今天" })
    expect(
      within(today)
        .getAllByRole("button")
        .map((node) => node.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining("newest")]))
    // 标题行带着菜单按钮，成了第一个时间段的标题；菜单换了分组也还开着。
    const headerLabel = document.querySelector(".side-scroll .side-label > span")
    expect(headerLabel?.textContent).toBe("今天")
    expect(screen.getAllByRole("menu").length).toBeGreaterThan(0)
    expect(screen.getByRole("group", { name: "更早" })).toBeTruthy()
    expect(document.querySelector(".sess .list-row-desc")).toBeNull()

    await openSubmenu(/^显示/)
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "项目" }))
    expect(
      Array.from(document.querySelectorAll(".sess .list-row-desc")).map((node) => node.textContent),
    ).toEqual(["beta", "alpha", "alpha"])
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "更新时间" }))
    expect(document.querySelectorAll(".sess time")).toHaveLength(0)
  })

  it("groups threads by status, marks the unread one, and marks everything read", async () => {
    const onMarkAllRead = vi.fn()
    renderSidebar({
      threads: [
        thread("t1", "p1", "waiting", "2026-10-20T03:00:00.000Z"),
        thread("t2", "p1", "fresh", "2026-10-20T02:00:00.000Z", { unread: true }),
        thread("t3", "p1", "seen", "2026-10-20T04:00:00.000Z"),
        thread("t4", "p1", "broken", "2026-10-20T01:00:00.000Z"),
      ],
      threadStatus: { t1: "waiting-approval", t2: "completed", t3: "completed", t4: "failed" },
      onMarkAllRead,
    })
    const fresh = screen.getByRole("button", { name: /fresh/ })
    expect(fresh.hasAttribute("data-unread")).toBe(true)
    expect(fresh.querySelector(".sess-dot")?.getAttribute("data-tone")).toBe("ready")
    expect(fresh.textContent).toContain("未读")
    // 看过的结果不再亮绿点。
    const seen = screen.getByRole("button", { name: /seen/ })
    expect(seen.querySelector(".sess-dot")?.getAttribute("data-tone")).toBe("idle")
    expect(seen.querySelector(".sess-dot")?.getAttribute("data-status")).toBe("completed")

    await openSubmenu(/^分组/)
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "状态" }))
    const group = (name: string) =>
      within(screen.getByRole("group", { name }))
        .queryAllByRole("button")
        .map((node) => node.querySelector(".sess-title")?.textContent)
        .filter(Boolean)
    expect(group("需要处理")).toEqual(["waiting", "fresh"])
    expect(group("出错")).toEqual(["broken"])
    expect(group("已完成")).toEqual(["seen"])

    await userEvent.click(screen.getByRole("menuitem", { name: "全部标为已读" }))
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it("shows only archived threads, unarchives one from its menu, and resets the filters", async () => {
    const menu = mockMenu()
    const onUnarchiveThread = vi.fn()
    renderSidebar({
      threads: [
        thread("t1", "p1", "Live thread", "2026-10-20T01:00:00.000Z"),
        thread("t2", "p1", "Archived thread", "2026-10-20T02:00:00.000Z", {
          archivedAt: "2026-10-21T00:00:00.000Z",
        }),
      ],
      onRenameThread: vi.fn(),
      onArchiveThread: vi.fn(),
      onUnarchiveThread,
    })
    const filterButton = () => screen.getByRole("button", { name: "自定义侧栏" })
    expect(titles()).toEqual(["Live thread"])

    await userEvent.click(filterButton())
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "已归档" }))
    expect(titles()).toEqual(["Archived thread"])
    expect(filterButton().hasAttribute("data-active")).toBe(true)
    await userEvent.keyboard("{Escape}")

    await chooseMenuItem(menu, screen.getByRole("button", { name: /Archived thread/ }), "unarchive")
    expect(menu.mock.lastCall?.[0]).toContainEqual({ id: "unarchive", label: "取消归档" })
    expect(menu.mock.lastCall?.[0]).not.toContainEqual(expect.objectContaining({ id: "archive" }))
    expect(onUnarchiveThread).toHaveBeenCalledExactlyOnceWith("t2")

    await userEvent.click(filterButton())
    await userEvent.click(await screen.findByRole("menuitem", { name: "重置" }))
    expect(titles()).toEqual(["Live thread"])
    expect(filterButton().hasAttribute("data-active")).toBe(false)
  })
})

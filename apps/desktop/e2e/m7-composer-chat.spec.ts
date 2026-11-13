/** 输入框、按轮时间线、运行指示与「用…打开」的端到端验收（fake agent）。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("composer: agent rail, models, thinking depth, fast mode, Ultracode, permissions, @files, /commands and skills", async () => {
  // Codex 指向一个不存在的文件，不管本机装没装 Codex，结果都一样。
  const { app, page } = await openThread("composer", {
    PIGCODE_CODEX_PATH: join(tmpdir(), "pigcode-e2e-no-codex"),
  })
  try {
    // 新会话用 agent 的默认模型。思考深度是本机偏好，上一次运行可能留下档位，先显式选一次「默认」：
    // 不指定档位，胶囊上只有模型名；目录里 Fake Sage 的默认档位是「中」，也不显示。
    const chip = page.getByRole("button", { name: /Agent 与模型/ })
    await expect(chip).toContainText("Fake Sage")

    await chip.click()
    // 底栏中间是思考深度的胶囊滑块：最左一档是「默认」，往右是 Fake Sage 的档位，方向键或点轨道都能选。
    const slider = page.getByRole("slider", { name: "思考深度" })
    const pill = page.locator(".model-effort-slider")
    const order = ["默认", "低", "中", "高", "最高"]
    const effort = async (name: string) => {
      await slider.focus()
      await page.keyboard.press("Home")
      for (let at = 0; at < order.indexOf(name); at += 1) await page.keyboard.press("ArrowRight")
      await expect(slider).toHaveAttribute("aria-valuetext", name)
    }
    await expect(slider).toHaveAttribute("max", "4")
    await effort("默认")
    await expect(chip).toHaveText(/Fake Sage$/)
    await effort("中")
    await expect(chip).toContainText("中")
    // 点胶囊的右端就是最高一档。
    const box = await pill.boundingBox()
    if (!box) throw new Error("the effort slider is not laid out")
    await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2)
    await expect(slider).toHaveAttribute("aria-valuetext", "最高")
    await effort("中")
    // 快速模式：Fake Sage 支持，点闪电打开后胶囊上多一个闪电，再点一次关掉。
    // 开关是本机偏好，上一次运行可能留着开，先关掉再测。
    const fast = page.getByRole("button", { name: "快速模式", exact: true })
    const ultracode = page.getByRole("button", { name: "Ultracode", exact: true })
    for (const toggle of [fast, ultracode]) {
      if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click()
    }
    await fast.click()
    await expect(fast).toHaveAttribute("aria-pressed", "true")
    await expect(chip).toHaveAttribute("aria-label", /· 快速/)
    await fast.click()
    await expect(chip).not.toHaveAttribute("aria-label", /快速/)
    // Ultracode 是闪电旁边的另一个开关，按模型记住，胶囊上也有标记。
    await ultracode.click()
    await expect(ultracode).toHaveAttribute("aria-pressed", "true")
    await expect(chip).toHaveAttribute("aria-label", /· Ultracode/)
    await ultracode.click()
    await expect(chip).not.toHaveAttribute("aria-label", /Ultracode/)
    await expect(page.getByRole("tab", { name: "Fake Agent" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    const list = page.getByRole("listbox", { name: "Fake Agent" })
    await expect(list.getByRole("option")).toHaveCount(2)
    // 其他 agent 只有选中后才列出自己的模型。
    await page.getByRole("tab", { name: "Claude Code" }).click()
    await expect(page.getByRole("listbox", { name: "Claude Code" })).toBeVisible()
    // Codex 启动失败时读取目录也失败；Host 不能因此崩溃，列表只是为空。
    await page.getByRole("tab", { name: "Codex" }).click()
    await expect(page.getByRole("listbox", { name: "Codex" })).toContainText("没有匹配的模型")
    await page.getByRole("tab", { name: "Fake Agent" }).click()
    await effort("最高")
    await expect(chip).toContainText("最高")
    // 选回「默认」：不再指定档位，胶囊上的档位也去掉。
    await effort("默认")
    await expect(chip).toHaveText(/Fake Sage$/)
    await effort("最高")
    await expect(chip).toContainText("最高")
    await page.getByRole("listbox", { name: "Fake Agent" }).getByText("Fake Swift").click()
    await expect(chip).toContainText("Fake Swift")
    await expect(chip).not.toContainText("最高")

    // 选完模型弹层不关，底栏马上换成 Fake Swift 的设置：没有档位，也没有快速模式与 Ultracode。
    // 权限在选择器底栏里，完全访问要确认，选择保存在线程上。
    await expect(page.getByTitle("Fake Swift 没有可调的思考深度")).toBeVisible()
    await expect(fast).toBeDisabled()
    await expect(ultracode).toBeDisabled()
    await page.getByRole("button", { name: /^权限/ }).click()
    await page.getByRole("menuitemradio", { name: /^监督审批/ }).click()
    await page.getByRole("button", { name: /^权限/ }).click()
    await page.getByRole("menuitemradio", { name: /完全访问/ }).click()
    await page.getByRole("button", { name: "启用完全访问" }).click()
    await expect(chip).toHaveAttribute("aria-label", /· 完全访问$/)

    // @ 引用文件，发送后用户气泡里是带图标的文件名，悬停看到完整路径。
    await page.locator(".tiptap").click()
    await page.keyboard.type("look at @ind")
    await expect(page.getByRole("listbox", { name: "文件" })).toContainText("index.ts")
    await page.keyboard.press("Enter")
    await expect(page.locator(".tiptap .mention-chip")).toHaveText("@src/index.ts")
    await page.keyboard.type("please")
    await page.keyboard.press("Enter")
    const sent = page.locator(".msg-user").filter({ hasText: "look at" })
    await expect(sent).toHaveText("look at index.ts please")
    await expect(sent.locator(".mention-file")).toHaveAttribute("title", "src/index.ts")
    await expect(page.locator(".msg-ai").filter({ hasText: "Hello from fake agent" })).toBeVisible()

    // ↑ 取回刚发送的消息；/ 命令切换权限。
    await page.locator(".tiptap").click()
    await page.keyboard.press("ArrowUp")
    await expect(page.locator(".tiptap")).toContainText("look at @src/index.ts please")
    // macOS 上 Control+A 只是移到行首，全选要用 ⌘A。
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await page.keyboard.type("/ask")
    await page.keyboard.press("Enter")
    await expect(chip).toHaveAttribute("aria-label", /· 监督审批$/)
    await expect(page.locator(".tiptap")).toHaveText("")

    // / 菜单里还有 Agent 自己的命令与 skill：skill 带标签，说明来自线程的工作目录。
    await page.keyboard.type("/")
    const commands = page.getByRole("listbox", { name: "命令" })
    const skill = commands.getByRole("option").filter({ hasText: "/fake-skill" })
    await expect(skill).toContainText("Skill")
    await expect(skill).toContainText("<topic>")
    await expect(skill).toContainText("Fake skill for /")
    await expect(commands.getByRole("option").filter({ hasText: "/review" })).toContainText("内置")
    // 选中后插入命令文字，随消息原样发给 Agent。
    await page.keyboard.type("fake-sk")
    await page.keyboard.press("Enter")
    await expect(page.locator(".tiptap")).toHaveText("/fake-skill ")
    await page.keyboard.type("release notes")
    await page.keyboard.press("Enter")
    await expect(page.locator(".msg-user").filter({ hasText: "/fake-skill" })).toHaveText(
      "/fake-skill release notes",
    )
  } finally {
    await app.close()
  }
})

test("a long model list scrolls by itself beside a fixed search and thinking depth", async () => {
  // 自定义模型把 fake agent 的目录撑长（Claude Code 有十几个模型）：只有列表滚动，
  // 搜索框和思考深度都留在弹层里，不会被挤出去。
  const profile = mkdtempSync(join(tmpdir(), "pigcode-e2e-picker-"))
  const customModels = Array.from({ length: 16 }, (_, index) => `fake-custom-${index + 1}`)
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ "agents.fake": { customModels } }))
  const { app, page } = await openThread("picker", { PIGCODE_PROFILE_DIR: profile })
  try {
    await page.getByRole("button", { name: /Agent 与模型/ }).click()
    const list = page.getByRole("listbox", { name: "Fake Agent" })
    await expect(list.getByRole("option")).toHaveCount(18)
    const popup = await page.locator(".model-picker").boundingBox()
    const search = page.getByRole("searchbox", { name: "搜索模型…" })
    const efforts = page.getByRole("slider", { name: "思考深度" })
    const searchBefore = await search.boundingBox()
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await search.boundingBox()).toEqual(searchBefore)
    for (const part of [search, efforts]) {
      const box = await part.boundingBox()
      if (!box || !popup) throw new Error("the model picker is not laid out")
      expect(box.y).toBeGreaterThanOrEqual(popup.y)
      expect(box.y + box.height).toBeLessThanOrEqual(popup.y + popup.height + 1)
    }
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
  }
})

test("timeline folds a finished turn's work and the sidebar animates running threads", async () => {
  const { app, page } = await openThread("timeline", { PIGCODE_FAKE_STEP_MS: "1200" })
  try {
    await page.locator(".tiptap").click()
    await page.keyboard.type("tools")
    await page.keyboard.press("Enter")

    // 运行中：侧栏显示点阵，线程头只有标签、没有状态胶囊；工作区展开、没有箭头并实时计时。
    await expect(page.locator(".sess.is-active .sess-indicator .dot-matrix")).toBeVisible()
    await expect(page.locator(".thread-tab[data-kind='main']")).toHaveAttribute(
      "data-active",
      "true",
    )
    await expect(page.getByRole("button", { name: /工作中/ })).toBeDisabled()
    await expect(page.locator(".turn-work .tool-row").first()).toBeVisible()
    // 右上角的状态胶囊显示当前待办。
    await expect(page.getByRole("button", { name: "展开状态" })).toContainText("阅读 README")
    // 运行中的命令「正在执行」扫光、默认收起；点开后输出一段段流进来。
    const live = page.locator(".cmd-row[data-status='running']")
    await expect(live.locator(".tool-shimmer")).toHaveText("正在执行")
    await expect(live.locator(".tool-row-head")).toHaveAttribute("aria-expanded", "false")
    await live.locator(".tool-row-head").click()
    const lint = page.locator(".cmd-row").filter({ hasText: "pnpm lint" }).first()
    await expect(lint.locator(".cmd-output")).toContainText("eslint src")

    // 结束后折叠成「已工作」，只留最终回答与改动汇总；展开后看到查阅分组与命令。
    const header = page.getByRole("button", { name: /已工作/ })
    await expect(header).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".sess.is-active .sess-indicator")).toHaveCount(0)
    await expect(page.locator(".msg-ai").filter({ hasText: "改好了" })).toBeVisible()
    await expect(page.locator(".turn-work")).toHaveCount(0)
    await header.click()
    await expect(page.getByRole("button", { name: /查阅/ })).toContainText("2 文件, 1 搜索")
    // 第一次 lint 失败显示「执行失败」，悬停看到退出码；修好后的命令展开能看到 `$ 命令` 与完整输出。
    const failed = page.locator(".cmd-row[data-status='failed']")
    await failed.locator(".tool-row-status").hover()
    await expect(page.locator(".tool-tip")).toContainText("退出码 1")
    const command = page.locator(".cmd-row").filter({ hasText: "pnpm lint && pnpm test" })
    await command.locator(".tool-row-kind").click()
    await expect(command.locator(".cmd-text pre")).toHaveText("pnpm lint && pnpm test")
    await expect(command.locator(".cmd-output")).toContainText("Tests  3 passed")

    // 从时间线打开右栏：编辑行里的文件名在这个文件自己的标签里打开它，改动汇总的「审查」打开 Diff。
    const edit = page.locator(".tool-row").filter({ hasText: "编辑" }).first()
    await edit.getByRole("button", { name: "index.ts", exact: true }).click()
    const panelTabs = page.locator(".right-panel").getByRole("tab")
    await expect(
      page.locator(".right-panel").getByRole("tab", { name: "index.ts" }),
    ).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("textbox", { name: "文件内容 src/index.ts" })).toHaveValue(
      "export const answer = 42\n",
    )
    await page.getByRole("button", { name: "展开已更改文件" }).click()
    await page.getByRole("button", { name: "审查" }).click()
    await expect(panelTabs).toHaveText(["index.ts", "Diff"])
    await expect(page.locator(".right-panel").getByRole("tab", { name: "Diff" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  } finally {
    await app.close()
  }
})

test("the header's open-in button opens the project with the chosen app", async () => {
  const { app, page, root } = await openThread("open-in")
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { __opened?: string[] }).__opened = opened
      shell.openPath = async (path: string) => {
        opened.push(path)
        return ""
      }
    })
    const opened = () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
    // 列表第一项总是文件管理器；选中后它成为左半边按钮的默认应用。
    await page.getByRole("button", { name: "选择打开方式" }).click()
    const items = page.locator(".open-in-menu .open-in-item")
    await expect(items.first()).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "复制路径" })).toBeVisible()
    await items.first().click()
    await expect.poll(opened).toEqual([root])

    await page.locator(".open-in-main").click()
    await expect.poll(opened).toEqual([root, root])
  } finally {
    await app.close()
  }
})

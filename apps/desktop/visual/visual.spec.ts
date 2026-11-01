/**
 * 视觉回归：主要界面各截浅色和深色两张。基线只在 CI 镜像上生成（visual-baselines.yml）。
 * 每次启动都用新的用户 profile 和 Electron 数据目录：前面的用例留下的插件、localStorage 偏好
 * 会改变界面。时间、耗时、终端输出这些每次都不同的内容在截图里遮住。走过的界面见 screens.ts。
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  launch,
  prepareProject,
  walkSettings,
  walkShell,
  walkWorkbench,
  type Theme,
  type Walk,
} from "./screens"

/** 每次运行都会变、但占位大小固定的区域：终端里的 shell 输出、Diff 基准下拉框。 */
function volatile(page: Page): Locator[] {
  return [page.locator(".terminal-view"), page.locator(".workbench-diff-base-select")]
}

/** 截图时额外加的样式：隐藏会变的文字（时间、耗时），见 hide-volatile.css。 */
const HIDE_VOLATILE = new URL("./hide-volatile.css", import.meta.url).pathname

/** 截当前整个窗口；用 soft 断言，一张不一致时其余的照样比对。 */
async function snap(page: Page, name: string, theme: Theme): Promise<void> {
  await expect.soft(page).toHaveScreenshot(`${name}-${theme}.png`, {
    maxDiffPixels: 0,
    animations: "disabled",
    mask: volatile(page),
    stylePath: HIDE_VOLATILE,
  })
}

/** 用中文界面启动，走一遍流程，每一步截一张图。 */
async function capture(theme: Theme, walk: (walk: Walk) => Promise<void>): Promise<void> {
  prepareProject()
  const { app, page } = await launch(theme)
  try {
    await walk({ app, page, locale: "zh-CN", step: (name) => snap(page, name, theme) })
  } finally {
    await app.close()
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`shell, composer and dialogs ${theme}`, async () => {
    test.setTimeout(120_000)
    await capture(theme, walkShell)
  })

  test(`conversation and workbench ${theme}`, async () => {
    test.setTimeout(150_000)
    await capture(theme, walkWorkbench)
  })

  test(`settings and plugins ${theme}`, async () => {
    test.setTimeout(180_000)
    await capture(theme, walkSettings)
  })
}

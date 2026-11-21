/**
 * 视觉回归：主要界面各截浅色和深色两张。基线只在 CI 镜像上生成（visual-baselines.yml）。
 * 每次启动都用新的用户 profile 和 Electron 数据目录：前面的用例留下的插件、localStorage 偏好
 * 会改变界面。时间、耗时、终端输出这些每次都不同的内容在截图里遮住。走过的界面见 screens.ts。
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { contrastRatio } from "../../../packages/ui-primitives/src/theme/color-math"
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

/**
 * 工具行文字和会话底色的最低对比度：动作、文件名和失败状态 4.5∶1；命令摘要是第三级（ZCode 的
 * subtlest），比动作淡一级，悬停整行时变成正文色，只要求 2.5∶1。
 */
const MIN_CONTRAST: Record<string, number> = {
  ".tool-row-kind": 4.5,
  ".file-chip": 4.5,
  ".cmd-summary": 2.5,
  '.tool-row[data-status="failed"] .tool-row-status': 4.5,
}

/** 在会话底色上合成实际渲染的文字色，计入半透明文字和主题的 OKLCH 颜色。 */
async function expectReadableToolText(page: Page): Promise<void> {
  const { background, samples } = await page.locator(".msgs").evaluate((list, selectors) => {
    const surface = getComputedStyle(list.closest(".workspace")!).backgroundColor
    const ctx = document.createElement("canvas").getContext("2d")!
    function paint(color: string): `#${string}` {
      ctx.fillStyle = surface
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const rgb = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)
      return `#${Array.from(rgb, (c) => c.toString(16).padStart(2, "0")).join("")}`
    }
    return {
      background: paint(surface),
      samples: selectors.map((selector) => ({
        selector,
        color: paint(getComputedStyle(list.querySelector(selector)!).color),
      })),
    }
  }, Object.keys(MIN_CONTRAST))
  for (const { selector, color } of samples) {
    expect(contrastRatio(color, background), selector).toBeGreaterThanOrEqual(
      MIN_CONTRAST[selector]!,
    )
  }
}

/** 截当前整个窗口；用 soft 断言，一张不一致时其余的照样比对。 */
async function snap(page: Page, name: string, theme: Theme): Promise<void> {
  if (name === "timeline-work-middle") await expectReadableToolText(page)
  const actions = page.locator(
    ".page-head button:visible, .dialog-foot button:visible, .dialog-close:visible",
  )
  for (const button of await actions.all()) {
    await expect(button).toHaveCSS("height", "28px")
  }
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

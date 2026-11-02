/**
 * 英文界面：用 en-US 走一遍视觉用例覆盖的所有界面（流程见 visual/screens.ts），不截图，只收集每一步
 * 页面上的文字（document.body.innerText 与 aria-label、title、placeholder），要求里面没有汉字。
 *
 * 用户内容不算：项目、提示词和会话标题本来就没有汉字；fake agent 的 showcase 脚本是 agent 的回答，
 * 按已知字符串排除——页面上每一段连续的汉字都必须和脚本里的某一段完全相同。脚本里和中文界面文案相同的
 * 片段（比如「文件」「新建」）只在整行都是脚本里的一行时才算用户内容，所以界面文案漏翻时不会被放过。
 */
import { expect, test, type Page } from "@playwright/test"
import { fakeShowcaseScript } from "../../host/src/agents/fake-showcase"
import { zhCN } from "../../../packages/ui-primitives/src/locale/messages.zh-CN"
import {
  launch,
  prepareProject,
  walkSettings,
  walkShell,
  walkWorkbench,
  type Walk,
} from "../visual/screens"

/** 一段连续的汉字，连同夹在中间的全角标点；只含标点的片段不算。 */
const HAN_RUN = /[\p{Script=Han}　-〿＀-￯]+/gu
const HAN = /\p{Script=Han}/u

function hanRuns(text: string): string[] {
  return (text.match(HAN_RUN) ?? []).filter((run) => HAN.test(run))
}

/** 对象里所有的字符串。 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

/** 中文界面文案里的汉字片段。 */
const UI_RUNS = new Set(Object.values(zhCN).flatMap(hanRuns))

/** 用户内容里出现的汉字片段：showcase 脚本产生的回答、思考、工具输入与输出，去掉和界面文案相同的片段。 */
const USER_CONTENT = new Set(
  stringsIn(fakeShowcaseScript(0))
    .flatMap(hanRuns)
    .filter((run) => !UI_RUNS.has(run)),
)

/** 比较整行时忽略有序列表的序号、空白、表格竖线和 markdown 标记：渲染后的表格行和列表项与脚本里的原文相同。 */
function normalizeLine(line: string): string {
  return line.replace(/^\s*\d+[.)]\s+/, "").replace(/[\s|*#>`-]/g, "")
}

/** 脚本里的每一行；页面上整行都等于其中一行时，行里的汉字都是用户内容。 */
const SCRIPT_LINES = new Set(
  stringsIn(fakeShowcaseScript(0))
    .flatMap((text) => text.split("\n"))
    .map(normalizeLine)
    .filter((line) => HAN.test(line)),
)

/** 页面上可见的文字，以及图标按钮、输入框上的辅助文字。 */
async function visibleText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = [document.body.innerText]
    for (const element of document.querySelectorAll("[aria-label], [title], [placeholder]")) {
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = element.getAttribute(name)
        if (value) texts.push(value)
      }
    }
    return texts
  })
}

/** 用英文界面走一遍流程；返回每一步里不属于用户内容的汉字和它所在的那一行。 */
async function findChinese(walk: (walk: Walk) => Promise<void>): Promise<string[]> {
  prepareProject()
  const { app, page } = await launch("light", "en-US")
  const found: string[] = []
  try {
    await walk({
      app,
      page,
      locale: "en-US",
      step: async (name) => {
        for (const text of await visibleText(page)) {
          for (const line of text.split("\n")) {
            if (SCRIPT_LINES.has(normalizeLine(line))) continue
            for (const run of hanRuns(line)) {
              if (!USER_CONTENT.has(run)) found.push(`${name}: ${run}  ←  ${line.trim()}`)
            }
          }
        }
      },
    })
  } finally {
    await app.close()
  }
  return [...new Set(found)]
}

test("the user content list comes from the showcase script and excludes UI text", () => {
  expect(USER_CONTENT.size).toBeGreaterThan(10)
  expect([...USER_CONTENT].filter((run) => UI_RUNS.has(run))).toEqual([])
})

test("shell, composer and dialogs have no Chinese in English", async () => {
  test.setTimeout(120_000)
  expect(await findChinese(walkShell)).toEqual([])
})

test("conversation and workbench have no Chinese in English", async () => {
  test.setTimeout(150_000)
  expect(await findChinese(walkWorkbench)).toEqual([])
})

test("settings and plugins have no Chinese in English", async () => {
  test.setTimeout(180_000)
  expect(await findChinese(walkSettings)).toEqual([])
})

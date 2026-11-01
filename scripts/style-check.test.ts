/** 样式检查：识别规则的单元测试，以及仓库各类数量不超过基线的回归测试。 */
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CATEGORIES,
  CATEGORY_LABELS,
  HARD_RULES,
  ceilingOf,
  duplicateSelectorFindings,
  formatCounts,
  grownFindings,
  hasColorLiteral,
  parseCss,
  readBaseline,
  scanStyles,
  sizeCategory,
  tsColorFindings,
  uiTextFindings,
} from "./style-check"

/** frontend 目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))

describe("CSS parsing", () => {
  it("counts a selector defined twice in the same context once", () => {
    const { rules } = parseCss(`
      .menu-item { padding: 4px; }
      @media (max-width: 960px) { .menu-item { padding: 2px; } }
      /* .menu-item { } in a comment */
      .menu-item  { color: var(--fg); }
      .a, .b { gap: 4px; }
      .a,.b { gap: 2px; }
    `)
    expect(duplicateSelectorFindings("x.css", rules).map((found) => found.text)).toEqual([
      ".menu-item",
      ".a,.b",
    ])
  })

  it("skips keyframes and reads declarations with their lines", () => {
    const { rules, declarations } = parseCss(
      ".spin {\n  animation: spin 1s;\n}\n@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n",
    )
    expect(rules.map((rule) => rule.selector)).toEqual([".spin"])
    expect(declarations).toEqual([{ property: "animation", value: "spin 1s", line: 2 }])
  })

  it("keeps semicolons inside url() and strings", () => {
    const { declarations } = parseCss(
      `.x { background: url(data:image/svg+xml;base64,AAA); content: "a;b"; }`,
    )
    expect(declarations.map((item) => item.property)).toEqual(["background", "content"])
  })
})

describe("literal detection", () => {
  it("finds color literals but not variables", () => {
    expect(hasColorLiteral("#fff")).toBe(true)
    expect(hasColorLiteral("1px solid #18181B")).toBe(true)
    expect(hasColorLiteral("rgb(0 0 0 / 40%)")).toBe(true)
    expect(hasColorLiteral("white")).toBe(true)
    expect(hasColorLiteral("var(--fg)")).toBe(false)
    expect(hasColorLiteral("color-mix(in oklch, var(--accent) 20%, transparent)")).toBe(false)
    expect(hasColorLiteral("oklch(from var(--accent) l c h / 50%)")).toBe(false)
    expect(hasColorLiteral("var(--white-ish)")).toBe(false)
  })

  it("classifies hardcoded radii, font sizes and control heights", () => {
    expect(sizeCategory("border-radius", "8px")).toBe("radius")
    expect(sizeCategory("border-top-left-radius", "calc(var(--ui-scale) * 6px)")).toBe("radius")
    expect(sizeCategory("border-radius", "var(--r-md)")).toBeNull()
    expect(sizeCategory("border-radius", "50%")).toBeNull()
    expect(sizeCategory("font-size", "calc(var(--ui-scale) * 12.5px)")).toBe("fontSize")
    expect(sizeCategory("font-size", "0.92em")).toBe("fontSize")
    expect(sizeCategory("font-size", "var(--fs-sm)")).toBeNull()
    expect(sizeCategory("height", "28px")).toBe("height")
    expect(sizeCategory("min-height", "calc(var(--ui-scale) * 30px)")).toBe("height")
    expect(sizeCategory("height", "1px")).toBeNull()
    expect(sizeCategory("height", "100%")).toBeNull()
    expect(sizeCategory("max-height", "320px")).toBeNull()
  })

  it("finds Chinese UI text in strings and JSX but not in comments", () => {
    const source = `
      // 注释里的中文不算
      /** 文档注释也不算 */
      export function Empty({ count }: { count: number }) {
        return <p title="提示" aria-label={"label"}>暂无变更 {count} 个{\`文件\${count}\`}</p>
      }
    `
    expect(uiTextFindings("empty.tsx", source).map((found) => found.text)).toEqual([
      "提示",
      "暂无变更",
      "个",
      "文件",
    ])
  })

  it("finds color literals in TypeScript strings", () => {
    const source = `const theme = { cursor: "#3b5bdb", link: "#section", shadow: "rgba(0,0,0,.2)" }`
    expect(tsColorFindings("theme.ts", source).map((found) => found.text)).toEqual([
      "#3b5bdb",
      "rgba(0,0,0,.2)",
    ])
  })
})

describe("style check", () => {
  const report = scanStyles(root)
  const baseline = readBaseline(root)

  it("reports the current counts", () => {
    console.info(`样式检查（当前数量 / 上限）：\n${formatCounts(report, baseline)}`)
    expect(Object.keys(baseline).sort()).toEqual([...CATEGORIES].sort())
  })

  it("treats UI text as a hard rule that ignores the baseline", () => {
    expect(HARD_RULES).toEqual(["uiText"])
    const loose = { ...baseline, uiText: { total: 5, files: { "a.tsx": 5 } } }
    expect(ceilingOf("uiText", loose)).toBe(0)
    expect(ceilingOf("color", loose)).toBe(baseline.color.total)
    const found = [{ file: "a.tsx", line: 1, text: "提示" }]
    expect(grownFindings({ ...report, uiText: found }, loose, "uiText")).toEqual(found)
    expect(formatCounts({ ...report, uiText: found }, loose)).toMatch(/uiText\s+1 \/ 上限 0/)
  })

  for (const category of CATEGORIES) {
    it(`does not add ${category} findings`, () => {
      const count = report[category].length
      const ceiling = ceilingOf(category, baseline)
      const added = grownFindings(report, baseline, category)
        .map((found) => `  ${found.file}:${found.line}  ${found.text}`)
        .join("\n")
      expect(
        count,
        `${CATEGORY_LABELS[category]}：${count} 处，超过上限 ${ceiling}。比基线多的位置：\n${added}`,
      ).toBeLessThanOrEqual(ceiling)
    })
  }
})

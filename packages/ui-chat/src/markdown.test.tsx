/** 验证助手消息的 Markdown：块结构（列表嵌套、任务项、表格、setext 标题）、流式围栏与行内标记。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { Markdown, parseBlocks } from "./markdown"

afterEach(cleanup)

function inLocale(node: ReactNode) {
  return render(<LocaleProvider locale="zh-CN">{node}</LocaleProvider>)
}

describe("parseBlocks", () => {
  it("splits headings, lists, quotes, rules and paragraphs", () => {
    const blocks = parseBlocks(
      ["# Title", "", "1. one", "2. two", "   more", "", "> quoted", "---", "plain", "text"].join(
        "\n",
      ),
    )
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { task: null, blocks: [{ kind: "paragraph", text: "one" }] },
          { task: null, blocks: [{ kind: "paragraph", text: "two\nmore" }] },
        ],
      },
      { kind: "quote", blocks: [{ kind: "paragraph", text: "quoted" }] },
      { kind: "rule" },
      { kind: "paragraph", text: "plain\ntext" },
    ])
  })

  it("nests indented lists, reads task items and setext headings", () => {
    const [heading, list] = parseBlocks(
      ["Overview", "===", "- [x] done", "- [ ] todo", "  - child", "  - other"].join("\n"),
    )
    expect(heading).toEqual({ kind: "heading", level: 1, text: "Overview" })
    expect(list?.kind === "list" ? list.items.map((item) => item.task) : null).toEqual([
      true,
      false,
    ])
    const nested = list?.kind === "list" ? list.items[1]?.blocks : []
    expect(nested?.map((block) => block.kind)).toEqual(["paragraph", "list"])
  })

  it("reads GFM tables with their alignment", () => {
    expect(
      parseBlocks("| Name | Size |\n| :--- | ---: |\n| a.ts | 1 KB |\n| b \\| c | 2 KB |"),
    ).toEqual([
      {
        kind: "table",
        align: ["left", "right"],
        header: ["Name", "Size"],
        rows: [
          ["a.ts", "1 KB"],
          ["b | c", "2 KB"],
        ],
      },
    ])
  })

  it("treats an unclosed fence as code until the end", () => {
    expect(parseBlocks("intro\n```ts\nconst a = 1\n# not a heading")).toEqual([
      { kind: "paragraph", text: "intro" },
      { kind: "code", lang: "ts", text: "const a = 1\n# not a heading", closed: false },
    ])
  })
})

describe("Markdown", () => {
  it("renders inline marks and only links safe protocols", () => {
    const { container } = render(
      <Markdown text="Run `pnpm test`, **then** _see_ [docs](https://example.com) or [x](javascript:void) \*literal\*" />,
    )
    expect(container.querySelector("code")?.textContent).toBe("pnpm test")
    expect(container.querySelector("strong")?.textContent).toBe("then")
    expect(container.querySelector("em")?.textContent).toBe("see")
    const links = container.querySelectorAll("a")
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute("href")).toBe("https://example.com")
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.textContent).toContain("or x *literal*")
  })

  it("links bare urls and shows safe images", () => {
    const { container } = render(
      <Markdown
        text={"See https://pigcode.dev/docs. ![shot](https://x.dev/a.png) ![bad](file:///etc)"}
      />,
    )
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://pigcode.dev/docs")
    expect(container.querySelector("a")?.textContent).toBe("https://pigcode.dev/docs")
    const images = container.querySelectorAll("img")
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute("alt")).toBe("shot")
  })

  it("renders fenced code in a code block with its language and copy button", () => {
    const { container } = inLocale(<Markdown text={"```bash\necho <b>hi</b>\n```"} />)
    expect(container.querySelector(".code-block-lang")?.textContent).toBe("bash")
    expect(container.querySelector(".code-block-body")?.textContent).toBe("echo <b>hi</b>\n")
    expect(container.querySelector("b")).toBeNull()
    expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy()
  })

  it("renders tables, task lists and nested lists", () => {
    const { container } = inLocale(
      <Markdown
        text={[
          "| A | B |",
          "|:-:|---|",
          "| 1 | 2 |",
          "",
          "- [x] shipped",
          "- plan",
          "  1. first",
        ].join("\n")}
      />,
    )
    expect(container.querySelector(".md-table th")?.getAttribute("data-align")).toBe("center")
    expect(container.querySelectorAll(".md-table td")).toHaveLength(2)
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true")
    expect(container.querySelector("ul ol li")?.textContent).toBe("first")
  })
})

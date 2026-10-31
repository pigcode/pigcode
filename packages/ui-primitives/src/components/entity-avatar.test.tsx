/** 验证头像缩写与色相的规则，以及头像组件的类名、尺寸和色相变量。 */
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { EntityAvatar, entityMark } from "./entity-avatar"

afterEach(() => cleanup())

describe("entityMark", () => {
  it("gives Claude Code and Codex two distinct letters", () => {
    expect(entityMark("claude", "Claude Code").initials).toBe("CC")
    expect(entityMark("codex", "Codex").initials).toBe("CO")
    expect(entityMark("fake", "Fake Provider").initials).toBe("FP")
  })

  it("splits on spaces, dashes, underscores and punctuation", () => {
    expect(entityMark("a", "pigcode-agent-foo").initials).toBe("PA")
    expect(entityMark("a", "ui_debug panel").initials).toBe("UD")
    expect(entityMark("a", "GPT-4o").initials).toBe("G4")
    expect(entityMark("a", "  echo  ").initials).toBe("EC")
  })

  it("uses one character for CJK names", () => {
    expect(entityMark("qwen", "通义千问").initials).toBe("通")
    expect(entityMark("kimi", "月之暗面 Kimi").initials).toBe("月")
    expect(entityMark("jp", "クロード").initials).toBe("ク")
  })

  it("falls back to the id, then to a question mark", () => {
    expect(entityMark("codex", "").initials).toBe("CO")
    expect(entityMark("", "").initials).toBe("?")
    expect(entityMark("x", "x").initials).toBe("X")
  })

  it("handles names without letters, marks that change length in upper case, and combining marks", () => {
    expect(entityMark("bot-agent", "🤖").initials).toBe("BA")
    expect(entityMark("x", "ßeta").initials).toBe("SS")
    expect(entityMark("x", "हिन्दी").initials).toBe("हि")
  })

  it("derives a stable hue from the id only", () => {
    const hue = entityMark("claude", "Claude Code").hue
    expect(entityMark("claude", "Something Else").hue).toBe(hue)
    expect(entityMark("claude", "Claude Code").hue).toBe(hue)
    expect(hue).toBeGreaterThanOrEqual(0)
    expect(hue).toBeLessThan(360)
    expect(entityMark("codex", "Codex").hue).not.toBe(hue)
  })
})

describe("EntityAvatar", () => {
  it("renders the initials with the size and hue", () => {
    const { container } = render(<EntityAvatar id="codex" name="Codex" size="sm" className="x" />)
    const avatar = container.firstElementChild as HTMLElement
    expect(avatar.className).toBe("entity-avatar x")
    expect(avatar.textContent).toBe("CO")
    expect(avatar.dataset.size).toBe("sm")
    expect(avatar.getAttribute("aria-hidden")).toBe("true")
    expect(avatar.style.getPropertyValue("--entity-hue")).toBe(
      String(entityMark("codex", "Codex").hue),
    )
  })

  it("defaults to the list size", () => {
    const { container } = render(<EntityAvatar id="claude" name="Claude Code" />)
    expect((container.firstElementChild as HTMLElement).dataset.size).toBe("lg")
  })
})

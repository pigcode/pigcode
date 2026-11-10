/** 验证 Agent 图标：driver 到品牌标志的映射、非默认实例的角标，以及认不出时退回缩写头像。 */
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AgentIcon, agentBrandOf } from "./agent-icon"
import { entityMark } from "./entity-avatar"

afterEach(cleanup)

describe("agentBrandOf", () => {
  it("maps the built-in drivers and nothing else", () => {
    expect(agentBrandOf("claude")).toBe("claude")
    expect(agentBrandOf("codex")).toBe("openai")
    expect(agentBrandOf("echo")).toBeNull()
    expect(agentBrandOf(null)).toBeNull()
  })
})

describe("AgentIcon", () => {
  it("draws the brand mark at the requested size, hidden from screen readers", () => {
    const { container } = render(<AgentIcon agentId="codex" name="Codex" size="lg" />)
    const icon = container.querySelector(".agent-icon")
    expect(icon?.getAttribute("data-size")).toBe("lg")
    expect(icon?.getAttribute("aria-hidden")).toBe("true")
    expect(icon?.querySelector(".agent-brand")?.getAttribute("data-brand")).toBe("openai")
    expect(icon?.querySelector(".agent-icon-badge")).toBeNull()
  })

  it("marks a non-default instance with its initials", () => {
    const { container } = render(
      <AgentIcon agentId="claude" instanceId="inst_work" name="公司 API" />,
    )
    expect(container.querySelector(".agent-brand")?.getAttribute("data-brand")).toBe("claude")
    expect(container.querySelector(".agent-icon-badge")?.textContent).toBe(
      entityMark("inst_work", "公司 API").initials,
    )
  })

  it("falls back to the initials avatar for an agent without a brand", () => {
    const { container } = render(<AgentIcon agentId="echo" name="Echo" />)
    expect(container.querySelector(".agent-brand")).toBeNull()
    expect(container.querySelector(".entity-avatar")?.getAttribute("data-size")).toBe("fill")
    expect(container.querySelector(".entity-avatar")?.textContent).toBe("EC")
  })
})

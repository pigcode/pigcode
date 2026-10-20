/** 验证 React 19 与 Testing Library 在 UI 包中可用。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

describe("ui-primitives", () => {
  it("renders a React element", () => {
    render(<button type="button">hello</button>)
    expect(screen.getByRole("button", { name: "hello" })).toBeTruthy()
  })
})

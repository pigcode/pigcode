/** 验证服务提供方页展示 Claude 检测结果。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ProviderPage } from "./provider-page"

describe("ProviderPage", () => {
  /** 版本与登录方式应直接展示。 */
  it("shows the detected Claude status", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ProviderPage
          detection={{
            installed: true,
            version: "2.1.304",
            loggedIn: true,
            authMethod: "claude.ai",
          }}
          onDetect={async () => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText(/2\.1\.304/)).toBeTruthy()
    expect(screen.getByText(/claude\.ai/)).toBeTruthy()
  })
})

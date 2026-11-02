/** 验证 LocaleProvider 在中文与英文之间切换。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider, useLocale } from "./locale"

function Probe() {
  const { t } = useLocale()
  return <span>{t("nav.newThread")}</span>
}

describe("locale", () => {
  it("renders Chinese messages", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Probe />
      </LocaleProvider>,
    )
    expect(screen.getByText("新会话")).toBeTruthy()
  })
})

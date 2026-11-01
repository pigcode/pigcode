/** 验证 Host 错误的解释：错误码对应的文案、两种语言都有说明、原始信息可以展开。 */
// @vitest-environment jsdom
import { HOST_ERROR_CODES } from "@pigcode/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { LocaleProvider, translate } from "../locale/locale"
import { ErrorNotice, hostErrorMessageKey, toHostError } from "./error-notice"

afterEach(cleanup)

describe("host error mapping", () => {
  it("reads the code and message from an RPC failure", () => {
    const failure = Object.assign(new Error("no git remotes found"), { code: "GIT_NO_REMOTE" })
    expect(toHostError(failure)).toEqual({ code: "GIT_NO_REMOTE", message: "no git remotes found" })
    expect(toHostError(new Error("boom"))).toEqual({ code: null, message: "boom" })
    expect(toHostError("offline")).toEqual({ code: null, message: "offline" })
  })

  it("explains every known code in both languages and nothing else", () => {
    for (const code of HOST_ERROR_CODES) {
      const key = hostErrorMessageKey(code)
      expect(key).toBe(`hostError.${code}`)
      if (!key) continue
      expect(translate("zh-CN", key)).toMatch(/\p{Script=Han}/u)
      expect(translate("en-US", key)).not.toMatch(/\p{Script=Han}/u)
    }
    expect(hostErrorMessageKey("COMMAND_FAILED")).toBeNull()
    expect(hostErrorMessageKey(null)).toBeNull()
  })
})

describe("ErrorNotice", () => {
  it("shows the explanation and reveals the raw message on demand", async () => {
    render(
      <LocaleProvider locale="en-US">
        <ErrorNotice error={{ code: "GIT_NO_REMOTE", message: "no git remotes found" }} />
      </LocaleProvider>,
    )
    expect(screen.getByText(/This repository has no GitHub remote/)).toBeTruthy()
    expect(screen.queryByText("no git remotes found")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Details" }))
    expect(screen.getByText("no git remotes found")).toBeTruthy()
  })

  it("shows unexplained errors as they are", () => {
    render(
      <LocaleProvider locale="en-US">
        <ErrorNotice error={{ code: null, message: "gh command failed" }} />
      </LocaleProvider>,
    )
    expect(screen.getByText("gh command failed")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})

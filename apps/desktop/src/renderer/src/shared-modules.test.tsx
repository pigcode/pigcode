// @vitest-environment jsdom
/**
 * 验证共享模块（ADR-0002）的核心承诺：插件按包名 import 宿主的 React 与 ui-primitives，拿到的是同一个
 * 实例，hook 能读到宿主的 context。
 *
 * 这里经过 `src/shared/*` 这几个入口（也就是 index.html 的 import map 指给插件的那几个模块）取 React 和
 * ui-primitives，再把插件组件放进宿主外壳里渲染。如果共享模块退化成另一个实例、或者 hooks 读不到
 * context，下面的用例会失败。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import * as facadeReactDom from "./shared/react-dom"
import { useFormStatus } from "./shared/react-dom"
import { useState } from "./shared/react"
import { LocaleProvider, useLocale } from "./shared/ui-primitives"
import { useTheme } from "./shared/ui-primitives"
import { PluginContentHost } from "@pigcode/ui-shell"
import * as hostReactDom from "react-dom"

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe("the shared modules keep the names plugins import", () => {
  it("exports the form hooks and re-exports the host's react-dom instance", () => {
    // ESM 的具名 import 在链接期解析：少一个名字，整个插件模块都加载失败，而不是拿到 undefined。
    expect(typeof useFormStatus).toBe("function")
    expect(typeof facadeReactDom.useFormState).toBe("function")
    expect(facadeReactDom.createPortal).toBe(hostReactDom.createPortal)
  })
})

describe("plugin components share the host's React", () => {
  it("reads the host's locale context and theme from inside a plugin component", async () => {
    /** 插件的写法：用共享模块里的 hook 读宿主状态。 */
    function PluginComponent() {
      const { locale } = useLocale()
      const theme = useTheme()
      return (
        <p data-testid="plugin">
          {locale}:{theme}
        </p>
      )
    }

    document.documentElement.dataset.theme = "dark"
    render(
      <LocaleProvider locale="en-US">
        <PluginContentHost id="shared" Component={PluginComponent} kind="panel" />
      </LocaleProvider>,
    )

    // 组件在宿主的 LocaleProvider 之内渲染，读到的是宿主的界面语言与主题。
    expect(screen.getByTestId("plugin").textContent).toBe("en-US:dark")

    // 主题切换后组件重画：useTheme 订阅的是同一个根元素属性。MutationObserver 在微任务里回调。
    act(() => {
      document.documentElement.dataset.theme = "light"
    })
    await waitFor(() => expect(screen.getByTestId("plugin").textContent).toBe("en-US:light"))
  })

  it("keeps a plugin component's own state alive through the host's React", () => {
    /** 组件自己持有一个计数器：只有宿主的 React 在渲染它时更新才会生效。 */
    function Counter() {
      const [count, setCount] = useState(0)
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          count {count}
        </button>
      )
    }

    render(
      <LocaleProvider locale="zh-CN">
        <PluginContentHost id="counter" Component={Counter} kind="panel" />
      </LocaleProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "count 0" }))
    expect(screen.getByRole("button", { name: "count 1" })).toBeTruthy()
  })
})

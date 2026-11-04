/**
 * 示例 UI 插件：用宿主的 React 和 `@pigcode/ui-primitives` 写界面（ADR-0002）。
 *
 * 插件按包名 `import "react"` / `import "@pigcode/ui-primitives"`，拿到的是宿主的同一份实例：
 * - `useState` 是宿主的 React hook，组件渲染在宿主的外壳里；
 * - `useLocale()`、`useTheme()` 读到宿主的界面语言和当前主题，切换后自动重画；
 * - ui-primitives 的 Button、Badge、ListRow、EmptyState 和宿主界面完全一致。
 *
 * Panel、Surface 和设置页都传 `Component`，这是插件界面的唯一写法（ADR-0002）；旧的
 * `render(container)` DOM 写法已删除，还在传的插件在登记时被拒绝。
 */
import { useState } from "react"
import { Badge, Button, EmptyState, ListRow, useLocale, useTheme } from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

/** 按界面语言取文案；插件自己的文字不走宿主的语言包。 */
const TEXT = {
  "zh-CN": {
    greeting: "来自宿主的 React",
    hook: "同一个 React 实例：这里的状态由宿主渲染。",
    increment: "点我加一",
    clicks: (count: number) => `点了 ${count} 次`,
    theme: "主题",
    locale: "语言",
    empty: "还没有点击",
    emptyDesc: "按钮用的是 ui-primitives 的 Button。",
  },
  "en-US": {
    greeting: "React from the host",
    hook: "The same React instance: the host renders this state.",
    increment: "Click me",
    clicks: (count: number) => `Clicked ${count} times`,
    theme: "Theme",
    locale: "Language",
    empty: "Nothing clicked yet",
    emptyDesc: "The button is ui-primitives' Button.",
  },
}

type Copy = (typeof TEXT)["zh-CN"]

/** 按当前界面语言取一份文案。 */
function copyFor(locale: string): Copy {
  return locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
}

/** 面板内容：state 由宿主的 React 持有，主题与语言用宿主的 hook 读取。 */
export function ReactPanel() {
  const { locale } = useLocale()
  const theme = useTheme()
  const text = copyFor(locale)
  const [count, setCount] = useState(0)
  return (
    <div className="react-panel">
      <p className="hint">{text.hook}</p>
      <ListRow title={text.theme} meta={<Badge variant="info">{theme}</Badge>} />
      <ListRow title={text.locale} meta={<Badge>{locale}</Badge>} />
      <Button variant="primary" onClick={() => setCount((value) => value + 1)}>
        {text.increment}
      </Button>
      {count === 0 ? (
        <EmptyState size="compact" title={text.empty} description={text.emptyDesc} />
      ) : (
        <p className="react-panel-count">{text.clicks(count)}</p>
      )}
    </div>
  )
}

/** Surface 内容：和 Panel 用同一个组件，验证两处拿到的都是宿主的 React。 */
function ReactSurface() {
  return <ReactPanel />
}

/** 设置页内容。 */
function ReactSettings() {
  return <ReactPanel />
}

export function apply(ctx: ClientPluginContext): () => void {
  const disposePanel = ctx.panels.register({
    id: "react-panel",
    title: "React Panel",
    Component: ReactPanel,
  })
  const disposeSurface = ctx.surfaces.register({
    id: "react-inspector",
    title: "React Inspector",
    description: "Rendered with the host's React and ui-primitives.",
    Component: ReactSurface,
  })
  const disposeSettings = ctx.settingsPages.register({
    id: "react-settings",
    title: "React Settings",
    Component: ReactSettings,
  })
  return () => {
    disposePanel()
    disposeSurface()
    disposeSettings()
  }
}

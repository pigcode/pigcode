/**
 * 原型：手机端的主要界面（pigcode/monorepo#94）。一次性代码，只留在 prototype/mobile-screens 分支上。
 *
 * 三套结构不同的方案放在同一个页面里，用地址里的 `?v=A|B|C` 切换；`s` 是停在哪一块界面，`c` 是连接状态。
 * 时间线、审批卡和提问卡直接用桌面端的 ui-chat 组件，数据是 data.ts 里的假会话，不连 Host。
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { LocaleProvider } from "@pigcode/ui-primitives"
import "@pigcode/ui-primitives/styles/globals.css"
import "./mobile.css"
import { App } from "./app"

createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <LocaleProvider locale="zh-CN">
      <App />
    </LocaleProvider>
  </StrictMode>,
)

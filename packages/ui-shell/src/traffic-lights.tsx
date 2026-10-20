/** 在没有系统原生交通灯的平台上绘制窗口栏占位控件。 */
import type { ReactElement } from "react"

/** 判断当前平台是否需要 renderer 自绘交通灯。 */
export function shouldRenderCustomTraffic(platform: string | undefined): boolean {
  return platform !== "darwin"
}

/** 绘制非 macOS 的交通灯占位，macOS 完全交给 BrowserWindow 原生控件。 */
export function TrafficLights(): ReactElement | null {
  if (!shouldRenderCustomTraffic(window.pigcodeNative?.platform)) return null
  return (
    <div className="traffic" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  )
}

import { devNull } from "node:os"

/**
 * 测试里的 git 子进程不读本机的全局与系统配置：开发机上的提交签名、fsmonitor 等设置
 * 会让并行跑的 git 测试卡住，结果也无法复现。测试仓库各自写入 user.name/email。
 */
process.env.GIT_CONFIG_GLOBAL = devNull
process.env.GIT_CONFIG_NOSYSTEM = "1"

/**
 * jsdom 不实现布局，ProseMirror 在输入后会读取 Range 的几何信息。
 * 返回空矩形即可，测试只关心文本与事件。
 */
if (typeof window !== "undefined" && typeof Range !== "undefined") {
  const emptyRects = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  } as unknown as DOMRectList
  Range.prototype.getClientRects = () => emptyRects
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

/** ProseMirror 用 elementFromPoint 把鼠标坐标换算成文档位置；jsdom 没有布局，返回 null。 */
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null
}

/**
 * jsdom 26 没有 PointerEvent，而 Base UI 的点击分发依赖它。
 * 用 MouseEvent 子类补齐最小字段，仅用于测试环境。
 */
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? ""
    }
  }

  Object.defineProperty(window, "PointerEvent", {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  })
}

/** 终端视图测试：mock xterm 验证实例生命周期、PTY 输入输出与 resize 接线。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalView, type TerminalHandle } from "./terminal-view"

/** xterm 与 fit addon 的假实现；jsdom 不支持真实 canvas，真实终端由 E2E 覆盖。 */
const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void
  type ResizeHandler = (size: { cols: number; rows: number }) => void

  /** 只记录 dispose 调用的订阅句柄。 */
  class FakeDisposable {
    readonly dispose = vi.fn()
  }

  /** 记录构造参数、订阅处理器，并允许测试手动触发事件。 */
  class FakeTerminal {
    static instances: FakeTerminal[] = []
    readonly options: Record<string, unknown>
    readonly open = vi.fn()
    readonly write = vi.fn()
    readonly focus = vi.fn()
    readonly loadAddon = vi.fn()
    readonly dispose = vi.fn()
    readonly dataDisposable = new FakeDisposable()
    readonly resizeDisposable = new FakeDisposable()
    cols = 80
    rows = 24
    private readonly dataHandlers = new Set<DataHandler>()
    private readonly resizeHandlers = new Set<ResizeHandler>()

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeTerminal.instances.push(this)
    }

    onData(handler: DataHandler): FakeDisposable {
      this.dataHandlers.add(handler)
      return this.dataDisposable
    }

    onResize(handler: ResizeHandler): FakeDisposable {
      this.resizeHandlers.add(handler)
      return this.resizeDisposable
    }

    emitData(data: string): void {
      for (const handler of this.dataHandlers) handler(data)
    }

    emitResize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
      for (const handler of this.resizeHandlers) handler({ cols, rows })
    }
  }

  class FakeFitAddon {
    static instances: FakeFitAddon[] = []
    /** 测试可以让 fit 改变终端尺寸，模拟真实 fit addon 量出新的行列数。 */
    static onFit: (() => void) | null = null
    readonly fit = vi.fn(() => FakeFitAddon.onFit?.())

    constructor() {
      FakeFitAddon.instances.push(this)
    }
  }

  /** WebGL 渲染器的假实现；unavailable 时构造即抛错，模拟拿不到 WebGL 的环境。 */
  class FakeWebglAddon {
    static instances: FakeWebglAddon[] = []
    static unavailable = false
    readonly dispose = vi.fn()
    lose: (() => void) | null = null

    constructor() {
      if (FakeWebglAddon.unavailable) throw new Error("WebGL2 not supported")
      FakeWebglAddon.instances.push(this)
    }

    onContextLoss(handler: () => void): FakeDisposable {
      this.lose = handler
      return new FakeDisposable()
    }
  }

  return { FakeTerminal, FakeFitAddon, FakeWebglAddon }
})

/** 可控的 ResizeObserver，用于驱动 fit。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMock.FakeTerminal }))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMock.FakeFitAddon }))
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: xtermMock.FakeWebglAddon }))

/** jsdom 没有 tokens.css 的计算值，也没有画布：token 直接读 <html> 的内联变量，颜色只认十六进制。 */
vi.mock("@pigcode/ui-primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pigcode/ui-primitives")>()
  return {
    ...actual,
    documentTokenReader: () => (name: string) =>
      document.documentElement.style.getPropertyValue(name).trim(),
    resolveCssColor: actual.parseCssColor,
  }
})

/** 读取指定序号的假终端；缺失时让测试立即失败。 */
function terminalAt(index: number): InstanceType<typeof xtermMock.FakeTerminal> {
  const terminal = xtermMock.FakeTerminal.instances[index]
  if (!terminal) throw new Error(`terminal ${index} was not created`)
  return terminal
}

/** 读取指定序号的 fit addon；缺失时让测试立即失败。 */
function fitAddonAt(index: number): InstanceType<typeof xtermMock.FakeFitAddon> {
  const addon = xtermMock.FakeFitAddon.instances[index]
  if (!addon) throw new Error(`fit addon ${index} was not created`)
  return addon
}

/** 读取指定序号的 ResizeObserver；缺失时让测试立即失败。 */
function observerAt(index: number): FakeResizeObserver {
  const observer = FakeResizeObserver.instances[index]
  if (!observer) throw new Error(`resize observer ${index} was not created`)
  return observer
}

describe("TerminalView", () => {
  beforeEach(() => {
    xtermMock.FakeTerminal.instances.length = 0
    xtermMock.FakeFitAddon.instances.length = 0
    xtermMock.FakeWebglAddon.instances.length = 0
    xtermMock.FakeWebglAddon.unavailable = false
    FakeResizeObserver.instances.length = 0
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  })

  afterEach(() => {
    // vitest 未开启 globals，Testing Library 不会自动清理上一次渲染。
    cleanup()
    vi.unstubAllGlobals()
  })

  it("creates a terminal on the host element and disposes it", () => {
    const { unmount } = render(<TerminalView />)

    const terminal = terminalAt(0)
    expect(terminal.options).toMatchObject({ cursorBlink: true, fontSize: 13 })
    expect(terminal.open).toHaveBeenCalledWith(screen.getByTestId("terminal-view"))
    expect(terminal.loadAddon).toHaveBeenCalled()
    expect(fitAddonAt(0).fit).toHaveBeenCalled()

    unmount()
    expect(terminal.dataDisposable.dispose).toHaveBeenCalled()
    expect(terminal.resizeDisposable.dispose).toHaveBeenCalled()
    expect(observerAt(0).disconnect).toHaveBeenCalled()
    expect(terminal.dispose).toHaveBeenCalled()
  })

  it("writes incoming output through the ready handle", () => {
    const handles: TerminalHandle[] = []
    render(<TerminalView onReady={(handle) => handle && handles.push(handle)} />)

    const terminal = terminalAt(0)
    expect(terminal.write).not.toHaveBeenCalled()

    const handle = handles[0]
    if (!handle) throw new Error("ready handle was not exposed")
    handle.write("pty output")
    expect(terminal.write).toHaveBeenCalledWith("pty output")
  })

  it("draws with WebGL and falls back to the DOM renderer when the context is lost", () => {
    const view = render(<TerminalView />)
    const webgl = xtermMock.FakeWebglAddon.instances[0]
    expect(webgl).toBeDefined()
    expect(terminalAt(0).loadAddon).toHaveBeenCalledWith(webgl)
    // GPU 上下文丢了：释放 WebGL，xterm 自己退回 DOM 渲染，终端照常可用。
    act(() => webgl?.lose?.())
    expect(webgl?.dispose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(webgl?.dispose).toHaveBeenCalledTimes(1)
  })

  it("keeps the DOM renderer when WebGL is unavailable", () => {
    xtermMock.FakeWebglAddon.unavailable = true
    const onReady = vi.fn()
    render(<TerminalView onReady={onReady} />)
    expect(xtermMock.FakeWebglAddon.instances).toHaveLength(0)
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ write: expect.any(Function) }))
  })

  it("releases WebGL with the terminal", () => {
    const view = render(<TerminalView />)
    view.unmount()
    expect(xtermMock.FakeWebglAddon.instances[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it("forwards typed data and resize events", () => {
    const onData = vi.fn()
    const onResize = vi.fn()
    render(<TerminalView onData={onData} onResize={onResize} />)

    const terminal = terminalAt(0)
    act(() => terminal.emitData("echo hi\r"))
    expect(onData).toHaveBeenCalledWith("echo hi\r")

    act(() => terminal.emitResize(120, 40))
    expect(onResize).toHaveBeenCalledWith(120, 40)
  })

  it("hands the size from the very first fit to the PTY", () => {
    // 真实 fit addon 在挂载时就量出面板的行列数；这次变化发生在订阅之前的话，PTY 会一直停在 80×24。
    xtermMock.FakeFitAddon.onFit = () =>
      xtermMock.FakeTerminal.instances.at(-1)?.emitResize(140, 13)
    try {
      const onResize = vi.fn()
      render(<TerminalView onResize={onResize} />)
      expect(onResize).toHaveBeenCalledWith(140, 13)
      expect(onResize).toHaveBeenLastCalledWith(140, 13)
    } finally {
      xtermMock.FakeFitAddon.onFit = null
    }
  })

  it("reports the size once the host is laid out, even when fit leaves it unchanged", () => {
    // jsdom 没有布局，宽高都是 0：当成藏在 display: none 里的面板。
    let width = 0
    const box = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => width)
    const height = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(() => width)
    try {
      const onResize = vi.fn()
      render(<TerminalView onResize={onResize} />)
      // 还没有布局：量不出尺寸，不报，调用方也就先不启动 shell。
      expect(onResize).not.toHaveBeenCalled()
      width = 600
      act(() => observerAt(0).trigger())
      expect(onResize).toHaveBeenCalledTimes(1)
      expect(onResize).toHaveBeenCalledWith(80, 24)
      // 只主动报一次；之后的尺寸变化走 xterm 的 onResize。
      act(() => observerAt(0).trigger())
      expect(onResize).toHaveBeenCalledTimes(1)
    } finally {
      box.mockRestore()
      height.mockRestore()
    }
  })

  it("refits when the host element resizes", () => {
    render(<TerminalView />)

    expect(observerAt(0).observe).toHaveBeenCalledWith(screen.getByTestId("terminal-view"))
    const fit = fitAddonAt(0).fit
    expect(fit).toHaveBeenCalledTimes(1)

    act(() => observerAt(0).trigger())
    expect(fit).toHaveBeenCalledTimes(2)
  })

  it("follows token changes on <html> and skips identical recomputes", async () => {
    const root = document.documentElement
    root.style.setProperty("--term-bg", "#101010")
    root.style.setProperty("--term-cursor", "#123456")
    render(<TerminalView />)

    const terminal = terminalAt(0)
    expect(terminal.options.theme).toEqual({ background: "#101010", cursor: "#123456" })

    root.style.setProperty("--term-cursor", "#D97757")
    await act(async () => {})
    expect(terminal.options.theme).toEqual({ background: "#101010", cursor: "#D97757" })

    const applied = terminal.options.theme
    root.dataset.theme = "dark"
    await act(async () => {})
    expect(terminal.options.theme).toBe(applied)

    root.removeAttribute("style")
    delete root.dataset.theme
  })

  it("keeps an explicit theme prop", async () => {
    const theme = { background: "#000000" }
    render(<TerminalView theme={theme} />)
    document.documentElement.style.setProperty("--term-bg", "#FFFFFF")
    await act(async () => {})
    expect(terminalAt(0).options.theme).toBe(theme)
    document.documentElement.removeAttribute("style")
  })

  it("releases the handle when unmounted", () => {
    const ready = vi.fn()
    const { unmount } = render(<TerminalView onReady={ready} />)

    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ write: expect.any(Function) }))
    unmount()
    expect(ready).toHaveBeenLastCalledWith(null)
  })
})

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
      for (const handler of this.resizeHandlers) handler({ cols, rows })
    }
  }

  class FakeFitAddon {
    static instances: FakeFitAddon[] = []
    readonly fit = vi.fn()

    constructor() {
      FakeFitAddon.instances.push(this)
    }
  }

  return { FakeTerminal, FakeFitAddon }
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

  it("refits when the host element resizes", () => {
    render(<TerminalView />)

    expect(observerAt(0).observe).toHaveBeenCalledWith(screen.getByTestId("terminal-view"))
    const fit = fitAddonAt(0).fit
    expect(fit).toHaveBeenCalledTimes(1)

    act(() => observerAt(0).trigger())
    expect(fit).toHaveBeenCalledTimes(2)
  })

  it("releases the handle when unmounted", () => {
    const ready = vi.fn()
    const { unmount } = render(<TerminalView onReady={ready} />)

    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ write: expect.any(Function) }))
    unmount()
    expect(ready).toHaveBeenLastCalledWith(null)
  })
})

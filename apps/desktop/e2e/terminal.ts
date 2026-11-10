/**
 * 读终端里的文字与配色：终端用 WebGL 画在画布上，DOM 里没有文字，
 * 通过 TerminalView 挂在宿主元素上的探针（pigcodeTerminal）读 xterm 的缓冲区与主题。
 */
import { expect, type Locator } from "@playwright/test"

/** locator 指向 .xterm 或它里面、外面的元素都可以；找不到终端时返回空字符串。 */
export function terminalText(locator: Locator): Promise<string> {
  return locator.first().evaluate((node) => {
    const host = (node.closest(".terminal-view") ?? node.querySelector(".terminal-view")) as
      (Element & { pigcodeTerminal?: { text(): string } }) | null
    return host?.pigcodeTerminal?.text() ?? ""
  })
}

/** 终端正在用的光标色（大写十六进制）。 */
export function terminalCursor(locator: Locator): Promise<string> {
  return locator.first().evaluate((node) => {
    const host = (node.closest(".terminal-view") ?? node.querySelector(".terminal-view")) as
      (Element & { pigcodeTerminal?: { theme(): { cursor?: string } } }) | null
    return (host?.pigcodeTerminal?.theme().cursor ?? "").toUpperCase()
  })
}

/** 等到终端里出现这段文字。 */
export async function expectTerminalText(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => terminalText(locator), { timeout: 15_000 }).toContain(text)
}

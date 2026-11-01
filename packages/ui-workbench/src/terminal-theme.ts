/** 终端配色：由 tokens.css 的 --term-* token 生成 xterm 主题，不另存一份色值。 */
import type { ColorResolver, TokenReader } from "@pigcode/ui-primitives"
import type { ITheme } from "@xterm/xterm"

type ColorKey = Exclude<keyof ITheme, "extendedAnsi">

/** xterm 主题字段与 token 的对应；ANSI 16 色的取值规则写在 tokens.css 里。 */
const TERMINAL_TOKENS: ReadonlyArray<readonly [ColorKey, string]> = [
  ["background", "--term-bg"],
  ["foreground", "--term-fg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-cursor-accent"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"],
]

/**
 * 按 token 生成 xterm 主题。read 读 token 的 CSS 值，resolve 把它换成 xterm 认的十六进制色；
 * 读不到或解析不了的字段不写，xterm 用自己的默认色。
 */
export function terminalTheme(read: TokenReader, resolve: ColorResolver): ITheme {
  const theme: Partial<Record<ColorKey, string>> = {}
  for (const [key, token] of TERMINAL_TOKENS) {
    const color = resolve(read(token))
    if (color) theme[key] = color
  }
  return theme
}

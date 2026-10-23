/**
 * 把「Enter」「Control+A」这样的按键描述转成 Electron 的键盘事件，交给 webview 的
 * webContents.sendInputEvent。CDP 的键盘与文字输入会被 Chromium 送到整个窗口里有焦点的地方
 * （用户正在打字的输入框），直接发给 guest 的事件只会到达页面本身。
 */

/** Electron sendInputEvent 的键盘事件。 */
export interface GuestKeyEvent {
  type: "rawKeyDown" | "char" | "keyUp"
  keyCode: string
  modifiers: Array<"alt" | "control" | "meta" | "shift">
}

const MODIFIERS: Record<string, GuestKeyEvent["modifiers"][number]> = {
  alt: "alt",
  option: "alt",
  control: "control",
  ctrl: "control",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  shift: "shift",
}

/** 按键名到 Electron 键名；value 为 true 的会输入字符（char 事件）。 */
const NAMED: Record<string, [string, boolean]> = {
  enter: ["Enter", true],
  return: ["Enter", true],
  tab: ["Tab", false],
  escape: ["Escape", false],
  esc: ["Escape", false],
  backspace: ["Backspace", false],
  delete: ["Delete", false],
  del: ["Delete", false],
  arrowup: ["Up", false],
  up: ["Up", false],
  arrowdown: ["Down", false],
  down: ["Down", false],
  arrowleft: ["Left", false],
  left: ["Left", false],
  arrowright: ["Right", false],
  right: ["Right", false],
  home: ["Home", false],
  end: ["End", false],
  pageup: ["PageUp", false],
  pagedown: ["PageDown", false],
  space: ["Space", true],
  " ": ["Space", true],
}

/** 解析按键描述；不认识的键抛错，让 agent 换一种写法。 */
export function keyEvents(description: string): GuestKeyEvent[] {
  const parts = description.split("+").map((part) => part.trim())
  const keyName = parts.pop() || (description.endsWith("+") ? "+" : "")
  const modifiers: GuestKeyEvent["modifiers"] = []
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${description}".`)
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  // 带 Ctrl / Meta / Alt 的组合键是快捷键，不输入字符。
  const shortcut = modifiers.some((modifier) => modifier !== "shift")
  const named = NAMED[keyName.toLowerCase()]
  if (!named && [...keyName].length !== 1) {
    throw new Error(`Unknown key "${keyName}" in "${description}".`)
  }
  const [keyCode, types] = named ?? [keyName, true]
  const events: GuestKeyEvent[] = [{ type: "rawKeyDown", keyCode, modifiers }]
  if (types && !shortcut) events.push({ type: "char", keyCode, modifiers })
  events.push({ type: "keyUp", keyCode, modifiers })
  return events
}

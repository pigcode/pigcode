/** 快捷键的显示文字：macOS 用 ⌘⌃⇧⌥ 符号，Windows/Linux 写成 Ctrl+Shift+K。 */

/** 当前是否运行在 macOS；有原生桥时以它为准，浏览器里退回 navigator.platform。 */
export function isMacPlatform(): boolean {
  if (typeof window === "undefined") return false
  const platform = window.pigcodeNative?.platform
  if (platform) return platform === "darwin"
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
}

const MAC_KEYS: Record<string, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Enter: "↵",
}

/**
 * 把 "Mod+N"、"Ctrl+`" 这样的描述转成当前平台的写法。
 * Mod 在 macOS 上是 ⌘，其他平台是 Ctrl。
 */
export function formatShortcut(keys: string, mac: boolean = isMacPlatform()): string {
  const parts = keys.split("+")
  if (mac) return parts.map((part) => MAC_KEYS[part] ?? part.toUpperCase()).join("")
  return parts
    .map((part) => (part === "Mod" ? "Ctrl" : part.length === 1 ? part.toUpperCase() : part))
    .join("+")
}

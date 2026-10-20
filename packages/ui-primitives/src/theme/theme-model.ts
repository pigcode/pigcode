// 负责把外观设置里的主题选择换算成实际使用的浅色或深色。

/** 外观设置里可选的主题。 */
export type ThemePreference = "light" | "dark" | "system"

/** 实际画在窗口上的主题。 */
export type ResolvedTheme = "light" | "dark"

/** 跟随系统时按系统深色模式决定，其余选择原样使用。 */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light"
  return preference
}

/** 把本机保存的字符串还原成主题选择；无法识别时跟随系统。 */
export function parseThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system"
}

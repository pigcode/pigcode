// 负责内置主题表和按 id 查找主题；颜色取自外观设置规格 §5.1。
import type { Hex } from "./color-math"

/** 一个模式下的主题颜色；accent 缺省表示使用主题自己的规则。 */
export type ThemeColors = { bg: Hex; fg: Hex; accent?: Hex }

/** 一套主题。light/dark 为 null 表示沿用 tokens.css 原值（仅 pigclaude）。 */
export type ThemeDefinition = {
  id: string
  name: string
  builtIn: boolean
  light: ThemeColors | null
  dark: ThemeColors | null
}

function preset(
  id: string,
  name: string,
  light: [Hex, Hex, Hex],
  dark: [Hex, Hex, Hex],
): ThemeDefinition {
  return {
    id,
    name,
    builtIn: true,
    light: { bg: light[0], fg: light[1], accent: light[2] },
    dark: { bg: dark[0], fg: dark[1], accent: dark[2] },
  }
}

/** 内置主题，顺序固定：pigcode、chatgpt、claude、linear、github、dracula、nord、solarized。 */
export const builtInThemes: readonly [ThemeDefinition, ...ThemeDefinition[]] = [
  { id: "pigcode", name: "pigcode", builtIn: true, light: null, dark: null },
  preset(
    "chatgpt",
    "ChatGPT",
    ["#FFFFFF", "#0D0D0D", "#339CFF"],
    ["#181818", "#FFFFFF", "#339CFF"],
  ),
  preset("claude", "Claude", ["#FAF9F5", "#141413", "#D97757"], ["#262624", "#FAF9F5", "#D97757"]),
  preset("linear", "Linear", ["#FCFCFD", "#1B1B1F", "#5E6AD2"], ["#0F1011", "#F7F8F8", "#7170FF"]),
  preset("github", "GitHub", ["#FFFFFF", "#1F2328", "#0969DA"], ["#0D1117", "#E6EDF3", "#2F81F7"]),
  preset(
    "dracula",
    "Dracula",
    ["#FFFBEB", "#1F1F1F", "#644AC9"],
    ["#282A36", "#F8F8F2", "#BD93F9"],
  ),
  preset("nord", "Nord", ["#ECEFF4", "#2E3440", "#5E81AC"], ["#2E3440", "#ECEFF4", "#88C0D0"]),
  preset(
    "solarized",
    "Solarized",
    ["#FDF6E3", "#586E75", "#268BD2"],
    ["#002B36", "#93A1A1", "#268BD2"],
  ),
]

/** 先在自定义主题里找、再在内置主题里找；都找不到时保证返回 pigcode。 */
export function findTheme(id: string, custom: readonly ThemeDefinition[]): ThemeDefinition {
  return (
    custom.find((theme) => theme.id === id) ??
    builtInThemes.find((theme) => theme.id === id) ??
    builtInThemes[0]
  )
}

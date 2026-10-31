/**
 * Agent 与插件的头像：名字的缩写，底色按 id 取一个稳定的色相。模型菜单、输入框胶囊、子代理标签、
 * 设置里的 Agent 与插件列表和侧栏会话行都用它，同一个 agent 在哪里都是同样的字母和颜色。
 * 样式在 indicators.css。
 */
import type { CSSProperties, ComponentProps } from "react"
import { cn } from "./cn"

/** 头像上的缩写与色相。 */
export interface EntityMark {
  initials: string
  /** 0–359 的色相；只由 id 决定。 */
  hue: number
}

/** 汉字、假名与谚文：一个字已经占满头像，只取一个。 */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 头像的缩写与色相：多个词取前两个词的首字母（Claude Code → CC），一个词取前两个字母
 * （Codex → CO），以汉字、假名或谚文开头时只取第一个字。名字里没有字母和数字时用 id 代替。
 */
export function entityMark(id: string, name: string): EntityMark {
  const split = (text: string) => text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean)
  const nameWords = split(name)
  const words = nameWords.length > 0 ? nameWords : split(id)
  const first = [...(words[0] ?? "?")]
  const lead = first[0] ?? "?"
  const second = words.length > 1 ? [...(words[1] ?? "")][0] : first[1]
  // 大写后可能变长（ß → SS），截回两个字符
  const initials = WIDE.test(lead)
    ? lead
    : [...`${lead}${second ?? ""}`.toUpperCase()].slice(0, 2).join("")
  let hue = 0
  for (const char of id) hue = (hue * 31 + char.charCodeAt(0)) % 360
  return { initials, hue }
}

/** 头像尺寸：sm 用在菜单、胶囊与标签里，md 是模型菜单的左栏，lg 是设置里的列表，inline 是一行文字里的彩色缩写。 */
export type EntityAvatarSize = "sm" | "md" | "lg" | "inline"

export type EntityAvatarProps = Omit<ComponentProps<"span">, "children"> & {
  id: string
  name: string
  size?: EntityAvatarSize
}

/** 渲染头像；只作装饰，名字由旁边的文字或外层的 aria-label 给出。 */
export function EntityAvatar({
  id,
  name,
  size = "lg",
  className,
  style,
  ...props
}: EntityAvatarProps) {
  const mark = entityMark(id, name)
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("entity-avatar", className)}
      data-size={size}
      style={{ ...style, "--entity-hue": mark.hue } as CSSProperties}
    >
      {mark.initials}
    </span>
  )
}

/** 没有图标的 agent 与插件用的头像：名字的缩写，底色按 id 取一个稳定的色相。 */
import type { CSSProperties } from "react"

/** 头像上的缩写：取每个词的首字母，最多两个。 */
export function entityInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean)
  const letters =
    words.length > 1 ? words.map((word) => word[0]) : [...(words[0] ?? "?").slice(0, 2)]
  return letters.slice(0, 2).join("").toUpperCase()
}

/** 按 id 得到一个稳定的色相。 */
export function entityHue(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

/** 渲染头像。 */
export function EntityAvatar({ id, name }: { id: string; name: string }) {
  return (
    <span
      className="entity-avatar"
      aria-hidden="true"
      style={{ "--entity-hue": entityHue(id) } as CSSProperties}
    >
      {entityInitials(name)}
    </span>
  )
}

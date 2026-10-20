// 负责设计稿里的单线图标。图形与 Open Design 的图标精灵一致。
import type { SVGProps } from "react"

const marks: Record<string, string> = {
  chat: '<path d="M5 18.5V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
  users:
    '<path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.8.7 3 2.5 3 5.2"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
  bars: '<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>',
  shield:
    '<path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6.3z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>',
  refresh:
    '<path d="M19.5 10.5A7.5 7.5 0 0 0 6 6.8L4.5 8.5M4.5 4.5v4h4M4.5 13.5A7.5 7.5 0 0 0 18 17.2l1.5-1.7M19.5 19.5v-4h-4"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  clip: '<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  folder:
    '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  "folder-plus":
    '<path d="M20.5 12V10a2 2 0 0 0-2-2h-7l-2-2.5h-4a2 2 0 0 0-2 2V17a2 2 0 0 0 2 2H12"/><path d="M18 15v6M15 18h6"/>',
  file: '<path d="M7 3.5h6.5L18 8v12.5H7z"/><path d="M13 3.5V8h5"/>',
  terminal:
    '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
  pencil: '<path d="M15.5 5.5l3 3L8 19H5v-3z"/><path d="M13.5 7.5l3 3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 6.5l2.5 2.5"/>',
  finger:
    '<path d="M7.5 19.5c1-1.7 1.5-3.8 1.5-6.5a3 3 0 0 1 6 0c0 1.2-.1 2.4-.3 3.5M12 13c0 3-.7 5.6-2 7.5M5 16.5c.5-1.1.5-2.3.5-3.5a6.5 6.5 0 0 1 13 0c0 2.3-.3 4.4-.9 6.3M6.3 7.3a8.5 8.5 0 0 1 11.4 0"/>',
  browser:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M6.5 6.8h.01M9 6.8h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.6"/>',
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  external:
    '<path d="M14 4.5h5.5V10M19.5 4.5l-8 8M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  swap: '<path d="M4.5 8h14M15 4.5L18.5 8 15 11.5M19.5 16h-14M9 12.5L5.5 16 9 19.5"/>',
  route:
    '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6.5a3.5 3.5 0 0 1 0 7h-5a3.5 3.5 0 0 0 0 7H16"/>',
  cube: '<path d="M12 3.5l7.5 4.3v8.4L12 20.5l-7.5-4.3V7.8z"/><path d="M12 12l7.5-4.2M12 12v8.5M12 12L4.5 7.8"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  download: '<path d="M12 4v11M7 10.5l5 4.5 5-4.5M5 19.5h14"/>',
  power: '<path d="M12 4v8M7 6.8a7 7 0 1 0 10 0"/>',
  server:
    '<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  snout:
    '<rect x="3" y="6" width="18" height="12.5" rx="6.25"/><path d="M9.5 10.3v3.9M14.5 10.3v3.9"/>',
  spark:
    '<path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1"/>',
  at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.5 6.9"/>',
  exit: '<path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15M10 16.5l4.5-4.5L10 7.5M14.5 12H4"/>',
  calendar:
    '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  database:
    '<path d="M5 6.5c0-1.4 3.1-2.5 7-2.5s7 1.1 7 2.5-3.1 2.5-7 2.5-7-1.1-7-2.5zM5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  contrast:
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 7h5M12 11h7.5M12 15h7M12 18.5h4"/>',
  tray: '<rect x="3.5" y="4" width="17" height="4" rx="1"/><rect x="9" y="11" width="11" height="9" rx="2"/>',
  badge:
    '<path d="M12 3.5l2.2 1.6 2.7-.1.8 2.6 2.2 1.6-.9 2.6.9 2.6-2.2 1.6-.8 2.6-2.7-.1-2.2 1.6-2.2-1.6-2.7.1-.8-2.6-2.2-1.6.9-2.6-.9-2.6 2.2-1.6.8-2.6 2.7.1z"/><path d="M9 12l2 2 4-4"/>',
  toggle:
    '<rect x="3.5" y="7.5" width="17" height="9" rx="4.5"/><circle cx="15.5" cy="12" r="2.2"/>',
  diff: '<path d="M12 4.5v7M8.5 8h7M8.5 18h7"/>',
  hand: '<path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.7-2.3L3.5 15.5a1.5 1.5 0 0 1 2.3-1.9L8 15.5V8.5a1.5 1.5 0 0 1 3 0"/>',
  wifi: '<path d="M4 9.5a12 12 0 0 1 16 0M7 12.8a7.5 7.5 0 0 1 10 0M10 16a3 3 0 0 1 4 0M12 19.2h.01"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c.8-3.3 3.6-5 7-5s6.2 1.7 7 5"/>',
  book: '<path d="M5 5.5A2 2 0 0 1 7 3.5h12v14H7a2 2 0 0 0-2 2zM5 19.5a2 2 0 0 0 2 2h12v-4"/>',
  palette:
    '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7h2.2a3.7 3.7 0 0 0 3.7-3.7c0-4.1-3.8-7.3-8.5-7.3z"/><path d="M7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01" stroke-width="2.4"/>',
  updown: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  undo: '<path d="M8.5 5L4.5 9l4 4"/><path d="M4.5 9h9.5a5.5 5.5 0 0 1 0 11H9"/>',
  pipette:
    '<path d="M14.5 6.5l3-3a2.1 2.1 0 0 1 3 3l-3 3"/><path d="M12.5 7.5l4 4M14.5 9.5L7 17l-2.5.5.5-2.5L12.5 7.5"/>',
}

type IconProps = SVGProps<SVGSVGElement> & { name: keyof typeof marks | string; small?: boolean }

/** 画出设计稿里的线性图标。未知名字不渲染图形。 */
export function Icon({ name, small, className, ...props }: IconProps) {
  const markup = marks[name] ?? ""
  return (
    <svg
      className={["ic", small ? "ic-sm" : "", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
      {...props}
    />
  )
}

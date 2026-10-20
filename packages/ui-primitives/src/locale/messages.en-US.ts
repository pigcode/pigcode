/** 英文消息目录；key 必须与 zh-CN 完全一致。 */
import type { zhCN } from "./messages.zh-CN"

export const enUS = {
  "nav.newThread": "New chat",
  "nav.search": "Search",
  "nav.projects": "Projects",
  "settings.title": "Settings",
  "settings.general": "General",
  "settings.appearance": "Appearance",
  "settings.providers": "Providers",
  "settings.plugins": "Plugins",
  "composer.placeholder": "Ask Claude to do something, @ to reference files, / for commands",
  "chat.send": "Send",
  "chat.interrupt": "Stop",
  "chat.approval.allowOnce": "Allow once",
  "chat.approval.allowSession": "Allow for this session",
  "chat.approval.deny": "Deny",
  "plugins.install": "Install local plugin",
  "plugins.enable": "Enable",
  "plugins.disable": "Disable",
  "plugins.empty": "No plugins installed yet",
  "status.reconnected": "Reconnected",
} satisfies Record<keyof typeof zhCN, string>

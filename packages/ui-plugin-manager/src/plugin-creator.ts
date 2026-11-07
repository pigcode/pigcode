/**
 * 「创建插件」：在新会话的输入框里预填一句开头，并附上 Pigcode 插件创建指南（作为附件，发送时接在文字后面）。
 * 不自动发送：用户写下想要的插件再发。agent 按指南把源码和市场目录文件写进项目的 plugins/，
 * 用户在插件页添加这个本地市场并安装。
 */
import type { Locale, MessageKey } from "@pigcode/ui-primitives"
import guideEnUS from "./creator/guide.en-US.md?raw"
import guideZhCN from "./creator/guide.zh-CN.md?raw"

/** 预填进新会话输入框的内容。 */
export interface PluginCreatorDraft {
  text: string
  context: { id: string; label: string; markdown: string }
}

/** 按界面语言生成「创建插件」的草稿。 */
export function pluginCreatorDraft(
  t: (key: MessageKey) => string,
  locale: Locale,
): PluginCreatorDraft {
  return {
    text: t("plugins.creator.prompt"),
    context: {
      id: "pigcode-plugin-creator",
      label: t("plugins.creator.guide"),
      markdown: (locale.startsWith("en") ? guideEnUS : guideZhCN).trim(),
    },
  }
}

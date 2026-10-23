/** 插件管理页与插件界面的文案：与 Agent 页同样的列表、详情与安装对话框，右栏里的插件标签。 */
export const pluginsZhCN = {
  "plugins.sub": "插件可以添加 agent、工具与界面，安装与启停立即生效。内置插件可以停用，不能卸载。",
  "plugins.expand": "{plugin} 的详情",
  "plugins.toggle": "启用 {plugin}",
  "plugins.status.failed": "加载失败",
  "plugins.status.conflict": "有冲突",
  "plugins.install.title": "安装插件",
  "plugins.install.description":
    "从 npm 包、tarball 或本地插件目录安装。安装后立即加载，不需要重启 Pigcode。",
  "plugins.install.submit": "安装",
  "plugins.failed": "操作失败：{reason}",
  "plugins.facts.package": "包名",
  "plugins.facts.kind": "类型",
  "plugins.facts.api": "API 版本",
  "plugins.facts.provides": "提供",
  "plugins.facts.none": "无",
  "plugins.surfaceGone": "这个插件标签已不可用：插件已停用或卸载。",
  "panel.plugins": "插件",
} as const

export const pluginsEnUS: Record<keyof typeof pluginsZhCN, string> = {
  "plugins.sub":
    "Plugins add agents, tools and UI. Installing and toggling take effect right away. Built-in plugins can be disabled but not uninstalled.",
  "plugins.expand": "Details of {plugin}",
  "plugins.toggle": "Enable {plugin}",
  "plugins.status.failed": "Failed to load",
  "plugins.status.conflict": "Conflict",
  "plugins.install.title": "Install a plugin",
  "plugins.install.description":
    "Install from an npm package, a tarball or a local plugin folder. It loads right away, no restart needed.",
  "plugins.install.submit": "Install",
  "plugins.failed": "Something went wrong: {reason}",
  "plugins.facts.package": "Package",
  "plugins.facts.kind": "Kind",
  "plugins.facts.api": "API version",
  "plugins.facts.provides": "Provides",
  "plugins.facts.none": "None",
  "plugins.surfaceGone":
    "This plugin tab is no longer available: the plugin was disabled or removed.",
  "panel.plugins": "Plugins",
}

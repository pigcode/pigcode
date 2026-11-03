/**
 * 内置命令登记到 Command 扩展点：新会话、侧栏、右侧面板、设置、插件、添加项目。
 * 命令面板和输入框 `/` 都从注册表读取，内置命令和插件命令走同一条路。
 * 关键词随界面语言变化，所以登记由 Shell 在语言变化时重做：先注销旧的，再登记新的。
 */
import type {
  CommandContribution,
  ContributionOwner,
  ExtensionRegistry,
} from "@pigcode/client-runtime"
import type { MessageKey } from "@pigcode/ui-primitives"

/** 内置命令需要的动作；缺省的动作不出现在面板与 `/` 里。 */
export interface BuiltinCommandActions {
  /** 新会话；不提供时 `/new` 与面板项都不出现。 */
  onNewThread?: () => void
  /** 打开「添加项目」对话框。 */
  onAddProject: () => void
  onSettings: () => void
  onPlugins: () => void
  onToggleSidebar?: () => void
  onToggleWorkbench?: () => void
}

/**
 * 登记内置命令；返回注销函数。顺序即命令面板「行动」组里的顺序。order 都小于 0：插件命令缺省 order 0，
 * 排在内置命令后面，空的命令面板里按回车执行的仍然是新会话。
 */
export function registerBuiltinCommands(
  registry: ExtensionRegistry,
  actions: BuiltinCommandActions,
  t: (key: MessageKey) => string,
): () => void {
  const builtin = (id: string): ContributionOwner => ({ kind: "builtin", id })
  const commands: CommandContribution[] = [
    ...(actions.onNewThread
      ? [
          {
            id: "new-thread",
            owner: builtin("shell"),
            order: -60,
            title: { key: "nav.newThread" as MessageKey },
            keywords: [t("palette.keywords.newThread")],
            icon: "plus",
            shortcut: "Mod+n",
            slash: "new",
            run: () => actions.onNewThread?.(),
          } satisfies CommandContribution,
        ]
      : []),
    ...(actions.onToggleSidebar
      ? [
          {
            id: "toggle-sidebar",
            owner: builtin("shell"),
            order: -50,
            title: { key: "palette.toggleSidebar" as MessageKey },
            keywords: [t("palette.keywords.toggleSidebar")],
            icon: "sidebar",
            shortcut: "Mod+b",
            run: () => actions.onToggleSidebar?.(),
          } satisfies CommandContribution,
        ]
      : []),
    ...(actions.onToggleWorkbench
      ? [
          {
            id: "toggle-workbench",
            owner: builtin("workbench"),
            order: -40,
            title: { key: "palette.toggleWorkbench" as MessageKey },
            keywords: [t("palette.keywords.toggleWorkbench")],
            icon: "tray",
            shortcut: "Mod+j",
            slash: "panel",
            run: () => actions.onToggleWorkbench?.(),
          } satisfies CommandContribution,
        ]
      : []),
    {
      id: "settings",
      owner: builtin("settings"),
      order: -30,
      title: { key: "settings.title" },
      keywords: [t("palette.keywords.settings")],
      icon: "gear",
      shortcut: "Mod+,",
      run: () => actions.onSettings(),
    },
    {
      id: "plugins",
      owner: builtin("plugins"),
      order: -20,
      title: { key: "settings.plugins" },
      keywords: [t("palette.keywords.plugins")],
      icon: "cube",
      run: () => actions.onPlugins(),
    },
    {
      id: "add-project",
      owner: builtin("projects"),
      order: -10,
      title: { key: "nav.addProject" },
      keywords: [t("palette.keywords.addProject")],
      icon: "folder-plus",
      run: () => actions.onAddProject(),
    },
  ]
  const disposers = commands.map((command) => registry.register("command", command))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

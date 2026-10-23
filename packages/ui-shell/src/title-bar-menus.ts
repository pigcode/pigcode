/** Windows/Linux 标题栏的「文件 编辑 视图 帮助」菜单内容；编辑与缩放交给系统角色。 */
import type { MessageKey } from "@pigcode/ui-primitives"
import type { TitleBarMenu } from "./title-bar"

/** 标题栏菜单需要的动作；全部由 Shell 提供。 */
export interface MenuActions {
  t: (key: MessageKey) => string
  newThread: () => void
  addProject: () => void
  settings: () => void
  about: () => void
  palette: () => void
  toggleSidebar: () => void
  toggleRight?: (() => void) | undefined
  toggleTerminal?: (() => void) | undefined
}

/** 文件、编辑、视图、帮助四个菜单；编辑与缩放等交给系统角色。 */
export function titleBarMenus(actions: MenuActions): TitleBarMenu[] {
  const { t } = actions
  return [
    {
      id: "file",
      label: t("menu.file"),
      items: [
        {
          id: "new-thread",
          label: t("nav.newThread"),
          accelerator: "CmdOrCtrl+N",
          run: actions.newThread,
        },
        { id: "add-project", label: `${t("nav.addProject")}…`, run: actions.addProject },
        { type: "separator" },
        {
          id: "settings",
          label: t("settings.title"),
          accelerator: "CmdOrCtrl+,",
          run: actions.settings,
        },
        { type: "separator" },
        { role: "quit", label: t("menu.quit") },
      ],
    },
    {
      id: "edit",
      label: t("menu.edit"),
      items: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { type: "separator" },
        { role: "selectAll", label: t("menu.selectAll") },
      ],
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        {
          id: "palette",
          label: t("menu.commandPalette"),
          accelerator: "CmdOrCtrl+K",
          run: actions.palette,
        },
        { type: "separator" },
        {
          id: "toggle-sidebar",
          label: t("palette.toggleSidebar"),
          accelerator: "CmdOrCtrl+B",
          run: actions.toggleSidebar,
        },
        ...(actions.toggleRight
          ? [
              {
                id: "toggle-right",
                label: t("palette.toggleWorkbench"),
                accelerator: "CmdOrCtrl+J",
                run: actions.toggleRight,
              },
            ]
          : []),
        ...(actions.toggleTerminal
          ? [
              {
                id: "toggle-terminal",
                label: t("panel.toggleTerminal"),
                accelerator: "Ctrl+`",
                run: actions.toggleTerminal,
              },
            ]
          : []),
        { type: "separator" },
        { role: "resetZoom", label: t("menu.resetZoom") },
        { role: "zoomIn", label: t("menu.zoomIn") },
        { role: "zoomOut", label: t("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("menu.fullScreen") },
        { type: "separator" },
        { role: "reload", label: t("menu.reload") },
        { role: "toggleDevTools", label: t("menu.devTools") },
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      items: [{ id: "about", label: t("menu.about"), run: actions.about }],
    },
  ]
}

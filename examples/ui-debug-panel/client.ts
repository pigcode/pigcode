/**
 * 示例 UI 插件：侧栏里一个 Panel、右侧面板里一种 Surface、设置里一页，再加一条 Command（命令面板与
 * 输入框 `/` 都能执行）；界面都用 ctx.ui 拼出来，和宿主的控件一模一样；文案随 ctx.locale 切换，
 * 主题变化时面板里的状态跟着更新。
 */
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

const TEXT = {
  "zh-CN": {
    hello: "来自 pigcode-ui-debug-panel 的问候",
    theme: "主题",
    locale: "语言",
    host: "宿主",
    hostDesc: "插件读到的宿主状态，主题切换后自动更新。",
    projects: "项目",
    projectsDesc: "通过 ctx.host.call 调用 Host 的 project.list。",
    load: "读取项目",
    empty: "还没有项目",
    emptyDesc: "添加一个项目后再读取。",
    verbose: "详细日志",
    verboseDesc: "示例开关：只保存在这个标签里。",
    settingsDesc: "示例开关：只保存在这一页里。",
    command: "运行示例命令",
    commandDesc: "面板与输入框 / 共用同一条命令。",
    commandKeyword: "调试 debug",
    runs: (count: number) => `示例命令已执行 ${count} 次`,
  },
  "en-US": {
    hello: "Hello from pigcode-ui-debug-panel",
    theme: "Theme",
    locale: "Language",
    host: "Host",
    hostDesc: "What the plugin reads from the host; follows theme changes.",
    projects: "Projects",
    projectsDesc: "Calls the Host's project.list through ctx.host.call.",
    load: "Load projects",
    empty: "No projects yet",
    emptyDesc: "Add a project, then load again.",
    verbose: "Verbose logging",
    verboseDesc: "A sample switch that lives only in this tab.",
    settingsDesc: "A sample switch that lives only on this page.",
    command: "Run the sample command",
    commandDesc: "One command shared by the palette and the composer's / list.",
    commandKeyword: "debug sample",
    runs: (count: number) => `Sample command ran ${count} times`,
  },
}

type Copy = (typeof TEXT)["zh-CN"]

function copyFor(locale: string): Copy {
  return locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
}

export function apply(ctx: ClientPluginContext): () => void {
  const { ui } = ctx
  const text = copyFor(ctx.locale.get())
  // 命令执行次数：面板里显示出来，E2E 用它确认命令面板与输入框 `/` 跑的是同一条命令。
  let runs = 0
  const listeners = new Set<() => void>()

  const disposePanel = ctx.panels.register({
    id: "debug-panel",
    title: "Debug Panel",
    render(container) {
      const draw = () => {
        container.replaceChildren(
          ui.text(text.hello, { tone: "muted", size: "sm" }),
          ui.list([
            { title: text.theme, meta: ctx.theme.get() },
            { title: text.locale, meta: ctx.locale.get() },
          ]),
          // 命令跑过才多这一行：插件没用它时界面和以前一样。
          ...(runs > 0 ? [ui.text(text.runs(runs), { tone: "muted", size: "sm" })] : []),
        )
      }
      draw()
      listeners.add(draw)
      const unsubscribeTheme = ctx.theme.subscribe(draw)
      return () => {
        listeners.delete(draw)
        unsubscribeTheme()
      }
    },
  })

  // 一条命令同时出现在命令面板和输入框的 `/` 里；停用插件后两处都消失。
  const disposeCommand = ctx.commands.register({
    id: "debug-run",
    title: text.command,
    keywords: [text.commandKeyword],
    icon: "spark",
    slash: "debug",
    run() {
      runs += 1
      for (const notify of [...listeners]) notify()
    },
  })

  const disposeSurface = ctx.surfaces.register({
    id: "debug-inspector",
    title: "Debug Inspector",
    description: text.hostDesc,
    render(container) {
      const theme = ui.badge(ctx.theme.get(), "accent")
      const projects = ui.section({
        title: text.projects,
        description: text.projectsDesc,
        children: [ui.empty({ title: text.empty, description: text.emptyDesc })],
      })
      const load = ui.button({
        label: text.load,
        variant: "primary",
        onClick: () => {
          void ctx.host.call("project.list", {}).then((result) => {
            const list = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
            const body = projects.querySelector(".pg-section-body")
            body?.replaceChildren(
              list.length > 0
                ? ui.list(
                    list.map((project) => ({
                      title: String(project.name ?? project.id),
                      description: String(project.rootPath ?? ""),
                    })),
                  )
                : ui.empty({ title: text.empty, description: text.emptyDesc }),
            )
          })
        },
      })
      container.append(
        ui.section({
          title: text.host,
          description: text.hostDesc,
          children: [
            ui.row({ title: text.theme, control: theme }),
            ui.row({ title: text.locale, control: ui.badge(ctx.locale.get()) }),
            ui.row({
              title: text.verbose,
              description: text.verboseDesc,
              control: ui.toggle({ label: text.verbose, checked: false }),
            }),
          ],
        }),
        load,
        projects,
      )
      return ctx.theme.subscribe((next) => {
        theme.textContent = next
      })
    },
  })

  const disposeSettings = ctx.settingsPages.register({
    id: "debug-settings",
    title: "Debug Settings",
    render(container) {
      const theme = ui.badge(ctx.theme.get(), "accent")
      container.append(
        ui.section({
          title: text.host,
          description: text.hostDesc,
          children: [
            ui.row({ title: text.theme, control: theme }),
            ui.row({ title: text.locale, control: ui.badge(ctx.locale.get()) }),
            ui.row({
              title: text.verbose,
              description: text.settingsDesc,
              control: ui.toggle({ label: text.verbose, checked: false }),
            }),
          ],
        }),
      )
      return ctx.theme.subscribe((next) => {
        theme.textContent = next
      })
    },
  })

  return () => {
    disposePanel()
    disposeCommand()
    disposeSurface()
    disposeSettings()
  }
}

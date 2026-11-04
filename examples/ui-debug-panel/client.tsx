/**
 * 示例 UI 插件，用到全部五个扩展点：侧栏里一个 Panel、右侧面板里一种 Surface、设置里一页、一条 Command
 * （命令面板与输入框 `/` 都能执行）和 debug_probe 工具的工具渲染器。
 *
 * 界面全部用宿主的 React 和 `@pigcode/ui-primitives` 写（ADR-0002）：Panel、Surface、设置页和宿主界面
 * 用的是同一套 Badge、Button、EmptyState、ListRow、SettingSection、SettingRow 与 Switch，主题和界面语言
 * 用 useTheme()、useLocale() 读取。插件自己的文案仍由插件按界面语言选择（下面的 TEXT）。
 */
import { useSyncExternalStore, useState } from "react"
import {
  Badge,
  Button,
  EmptyState,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
  useTheme,
} from "@pigcode/ui-primitives"
import type { ClientPluginContext, ClientToolCall } from "@pigcode/plugin-sdk"

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
    verboseDesc: "示例开关：只保存在这个面板里。",
    settingsDesc: "示例开关：只保存在这一页里。",
    command: "运行示例命令",
    commandKeyword: "调试 debug",
    runs: (count: number) => `示例命令已执行 ${count} 次`,
    probe: "调试探针",
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
    verboseDesc: "A sample switch that lives only in this panel.",
    settingsDesc: "A sample switch that lives only on this page.",
    command: "Run the sample command",
    commandKeyword: "debug sample",
    runs: (count: number) => `Sample command ran ${count} times`,
    probe: "Debug probe",
  },
}

type Copy = (typeof TEXT)["zh-CN"]

/** 按界面语言取文案；插件自己的文字不走宿主的语言包。 */
function copyFor(locale: string): Copy {
  return locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
}

/**
 * 命令执行次数。状态跟着这一次 apply 走：停用插件后计数回到 0，重新启用不会显示上一次的数
 * （模块会被缓存，放模块作用域就会跨启用残留）。组件通过 useSyncExternalStore 读它。
 */
interface RunCounter {
  subscribe: (listener: () => void) => () => void
  snapshot: () => number
}

function createRunCounter(): { counter: RunCounter; ran: () => void } {
  let runs = 0
  const listeners = new Set<() => void>()
  return {
    counter: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      snapshot: () => runs,
    },
    ran() {
      runs += 1
      for (const notify of [...listeners]) notify()
    },
  }
}

/** 宿主当前主题的徽标，Panel、Surface 和设置页共用。 */
function ThemeBadge() {
  const theme = useTheme()
  return <Badge variant="primary">{theme}</Badge>
}

/** 只在组件里有效的示例开关，带宿主的无障碍名称。 */
function VerboseSwitch({ label }: { label: string }) {
  const [checked, setChecked] = useState(false)
  return <Switch checked={checked} onCheckedChange={setChecked} aria-label={label} />
}

/** 侧栏 Panel：一句问候、宿主状态（用列表行，和侧栏的列表一样），以及命令执行次数（跑过才多一行）。 */
function DebugPanel({ counter }: { counter: RunCounter }) {
  const { locale } = useLocale()
  const text = copyFor(locale)
  const count = useSyncExternalStore(counter.subscribe, counter.snapshot, counter.snapshot)
  return (
    <>
      <p className="hint">{text.hello}</p>
      <ListRow title={text.theme} meta={<ThemeBadge />} />
      <ListRow title={text.locale} meta={<Badge>{locale}</Badge>} />
      <ListRow
        title={text.verbose}
        description={text.verboseDesc}
        actions={<VerboseSwitch label={text.verbose} />}
      />
      {count > 0 ? <p className="hint">{text.runs(count)}</p> : null}
    </>
  )
}

/** project.list 的结果形状由 Host 决定，插件自己校验后再显示。 */
type Project = { id: string; name: string; rootPath: string }

function projectRows(result: unknown): Project[] {
  if (!Array.isArray(result)) return []
  return result.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const project = item as Record<string, unknown>
    if (typeof project.id !== "string") return []
    return [
      {
        id: project.id,
        name: typeof project.name === "string" ? project.name : project.id,
        rootPath: typeof project.rootPath === "string" ? project.rootPath : "",
      },
    ]
  })
}

/** 右侧面板：宿主状态，以及点按钮后通过 ctx.host.call 读到的项目；分组和宿主设置页一样。 */
function DebugSurface({ call }: { call: ClientPluginContext["host"]["call"] }) {
  const { locale } = useLocale()
  const text = copyFor(locale)
  const [projects, setProjects] = useState<Project[]>([])
  return (
    <>
      <SettingSection title={text.host}>
        <SettingRow title={text.theme} value={<ThemeBadge />} />
        <SettingRow title={text.locale} value={<Badge>{locale}</Badge>} />
      </SettingSection>
      <SettingSection title={text.projects}>
        <SettingRow title={text.projectsDesc} />
        {projects.length > 0 ? (
          projects.map((project) => (
            <SettingRow key={project.id} title={project.name} description={project.rootPath} />
          ))
        ) : (
          <EmptyState size="compact" title={text.empty} description={text.emptyDesc} />
        )}
      </SettingSection>
      <Button
        variant="primary"
        onClick={() => {
          void call("project.list", {}).then((result) => setProjects(projectRows(result)))
        }}
      >
        {text.load}
      </Button>
    </>
  )
}

/** 设置页：宿主画页面标题，这里和宿主设置页一样用分组与设置行。 */
function DebugSettings() {
  const { locale } = useLocale()
  const text = copyFor(locale)
  return (
    <SettingSection title={text.host}>
      <SettingRow title={text.theme} value={<ThemeBadge />} />
      <SettingRow title={text.locale} value={<Badge>{locale}</Badge>} />
      <SettingRow title={text.verbose} description={text.settingsDesc}>
        <VerboseSwitch label={text.verbose} />
      </SettingRow>
    </SettingSection>
  )
}

/** 时间线里 debug_probe 工具的显示；停用插件后回到通用渲染器。 */
function DebugProbe({ tool }: { tool: ClientToolCall }) {
  const { locale } = useLocale()
  return <p className="hint">{`${copyFor(locale).probe} · ${tool.status}`}</p>
}

export function apply(ctx: ClientPluginContext): () => void {
  const text = copyFor(ctx.locale.get())
  const { counter, ran } = createRunCounter()
  // Surface 要调 Host：把 ctx 的 call 交给组件，组件本身仍是普通的 React 组件。
  const Panel = () => <DebugPanel counter={counter} />

  const disposePanel = ctx.panels.register({
    id: "debug-panel",
    title: "Debug Panel",
    Component: Panel,
  })

  // 一条命令同时出现在命令面板和输入框的 `/` 里；停用插件后两处都消失。
  const disposeCommand = ctx.commands.register({
    id: "debug-run",
    title: text.command,
    keywords: [text.commandKeyword],
    icon: "spark",
    slash: "debug",
    run() {
      ran()
    },
  })

  // 时间线里 debug_probe 工具的显示；停用插件后回到通用渲染器。
  const disposeToolRenderer = ctx.toolRenderers.register({
    id: "debug-probe",
    tools: ["debug_probe"],
    Component: DebugProbe,
  })

  const Surface = () => <DebugSurface call={ctx.host.call} />
  const disposeSurface = ctx.surfaces.register({
    id: "debug-inspector",
    title: "Debug Inspector",
    description: text.hostDesc,
    Component: Surface,
  })

  const disposeSettings = ctx.settingsPages.register({
    id: "debug-settings",
    title: "Debug Settings",
    Component: DebugSettings,
  })

  return () => {
    disposePanel()
    disposeCommand()
    disposeToolRenderer()
    disposeSurface()
    disposeSettings()
  }
}

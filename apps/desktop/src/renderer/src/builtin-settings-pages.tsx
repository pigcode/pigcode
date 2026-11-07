/**
 * 三个内置设置页登记到设置页扩展点：通用、外观归设置，Agent 归 Agent 管理。
 * 插件和定时任务不是设置页：它们是和聊天并列的顶层页面（workspace-pages）。
 * 顺序就是设置侧栏里的顺序。页面内容在第一次打开时才加载（settings-container），冷启动只加载这里的登记信息。
 */
import {
  Suspense,
  createContext,
  lazy,
  type ComponentType,
  type Context,
  type ReactNode,
  useState,
} from "react"
import type {
  ContributionIcon,
  ContributionOwner,
  ExtensionRegistry,
  SettingsPageContribution,
} from "@pigcode/client-runtime"
import type { AppearanceController } from "@pigcode/ui-primitives"
import { Icon } from "@pigcode/ui-shell"
import type { CoreDeps } from "./chat-container"

/** App 持有的外观控制器；外观页从这里读，和窗口用同一份。 */
export const AppearanceContext: Context<AppearanceController | null> =
  createContext<AppearanceController | null>(null)

type PageName = "GeneralPage" | "AppearanceContainer" | "AgentsContainer"

type SettingsModule = typeof import("./settings-container")
type PageComponent = ComponentType<{ deps: CoreDeps }>

/** 三页共用一份 settings-container 代码块：只加载一次，加载完后记下来。 */
let settingsModule: SettingsModule | null = null
let settingsModuleLoad: Promise<SettingsModule> | null = null
function loadSettingsModule(): Promise<SettingsModule> {
  settingsModuleLoad ??= import("./settings-container").then((module) => (settingsModule = module))
  return settingsModuleLoad
}

/**
 * 按需加载一个设置页组件。代码块已经加载时直接画，不经过 Suspense：每页各自的 lazy() 第一次渲染时
 * 总会挂起一次，换到还没打开过的页时内容区会空一帧。挂载时决定走哪条路，之后不再切换，页面状态不会丢。
 */
function page(name: PageName, deps: CoreDeps): () => ReactNode {
  const Lazy = lazy(() =>
    loadSettingsModule().then((module) => ({ default: module[name] as PageComponent })),
  )
  function BuiltinSettingsPage() {
    const [Loaded] = useState<PageComponent | null>(
      () => (settingsModule?.[name] as PageComponent | undefined) ?? null,
    )
    return Loaded ? (
      <Loaded deps={deps} />
    ) : (
      <Suspense fallback={null}>
        <Lazy deps={deps} />
      </Suspense>
    )
  }
  return () => <BuiltinSettingsPage />
}

/** 设计稿里的线性图标；Icon 自己带 ic 类与 aria-hidden，侧栏传来的同名属性不再重复。 */
function markIcon(name: string): ContributionIcon {
  return function SettingsPageIcon() {
    return <Icon name={name} />
  }
}

const builtin = (id: string): ContributionOwner => ({ kind: "builtin", id })

/** 登记三个内置设置页；返回注销函数。 */
export function registerBuiltinSettingsPages(
  registry: ExtensionRegistry,
  deps: CoreDeps,
): () => void {
  const pages: SettingsPageContribution[] = [
    {
      id: "general",
      owner: builtin("settings"),
      order: 10,
      title: { key: "settings.general" },
      icon: markIcon("toggle"),
      render: page("GeneralPage", deps),
    },
    {
      id: "appearance",
      owner: builtin("settings"),
      order: 20,
      title: { key: "settings.appearance" },
      icon: markIcon("contrast"),
      render: page("AppearanceContainer", deps),
    },
    {
      id: "agents",
      owner: builtin("agents"),
      order: 30,
      title: { key: "settings.agents" },
      icon: markIcon("server"),
      render: page("AgentsContainer", deps),
    },
  ]
  const disposers = pages.map((item) => registry.register("settingsPage", item))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

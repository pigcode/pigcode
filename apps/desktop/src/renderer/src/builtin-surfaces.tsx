/**
 * 六个内置 Surface 登记到 Surface 扩展点：名称、图标、快捷键、能否多开、切走后是否保持挂载、
 * 新标签的标题与内容。顺序就是启动器和「+」菜单里的顺序。内容组件在第一次打开时才加载，
 * 冷启动只加载这里的登记信息。
 */
import { Suspense, lazy, type ComponentType, type ReactNode } from "react"
import { FileDiff, Files, GitPullRequest, Globe, History, SquareTerminal } from "lucide-react"
import type {
  ContributionOwner,
  ExtensionRegistry,
  SurfaceContribution,
  SurfaceRenderProps,
} from "@pigcode/client-runtime"
import { FILE_SURFACE_KIND } from "@pigcode/ui-workbench"

/** 内置 Surface 的归属。 */
export const WORKBENCH_OWNER: ContributionOwner = { kind: "builtin", id: "workbench" }

type PaneName =
  "BrowserPane" | "TerminalPane" | "FilesPane" | "DiffPane" | "PrPane" | "CheckpointPane"

/** 按需加载一个内容组件。 */
function pane(name: PaneName): (props: SurfaceRenderProps) => ReactNode {
  const Pane = lazy(() =>
    import("./workbench-surfaces").then((module) => ({
      default: module[name] as ComponentType<SurfaceRenderProps>,
    })),
  )
  return (props) => (
    <Suspense fallback={null}>
      <Pane {...props} />
    </Suspense>
  )
}

/** 第 index 个标签的标题：终端总带序号，浏览器从第二个开始带。 */
const numbered = (name: string, index: number): string => `${name} ${index}`

const BUILTIN_SURFACES: SurfaceContribution[] = [
  {
    id: "browser",
    owner: WORKBENCH_OWNER,
    order: 10,
    title: { key: "workbench.browser" },
    icon: Globe,
    shortcut: "B",
    multiInstance: true,
    keepMounted: true,
    tabTitle: (name, index) => (index > 1 ? numbered(name, index) : name),
    render: pane("BrowserPane"),
  },
  {
    id: "terminal",
    owner: WORKBENCH_OWNER,
    order: 20,
    title: { key: "workbench.terminal" },
    icon: SquareTerminal,
    shortcut: "T",
    multiInstance: true,
    keepMounted: true,
    tabTitle: numbered,
    render: pane("TerminalPane"),
  },
  {
    id: "files",
    owner: WORKBENCH_OWNER,
    order: 30,
    title: { key: "workbench.files" },
    icon: Files,
    shortcut: "F",
    render: pane("FilesPane"),
  },
  {
    id: "diff",
    owner: WORKBENCH_OWNER,
    order: 40,
    title: { key: "workbench.diff" },
    icon: FileDiff,
    shortcut: "D",
    render: pane("DiffPane"),
  },
  {
    // 没有 gh 或没有登录时 PR 照样可以打开：Host 只在查询时才知道，原因显示在 PR 标签里。
    id: "pr",
    owner: WORKBENCH_OWNER,
    order: 50,
    title: { key: "workbench.pr" },
    icon: GitPullRequest,
    shortcut: "P",
    render: pane("PrPane"),
  },
  {
    id: "checkpoint",
    owner: WORKBENCH_OWNER,
    order: 60,
    title: { key: "workbench.checkpoint" },
    icon: History,
    shortcut: "C",
    render: pane("CheckpointPane"),
  },
]

/**
 * 登记六个内置 Surface，并预留文件标签的种类 "file"：它是标签种类，不是 Surface，
 * 插件用这个 id 登记会按和工作台的冲突拒绝。返回注销函数。
 */
export function registerBuiltinSurfaces(registry: ExtensionRegistry): () => void {
  const disposers = [
    registry.reserve("surface", FILE_SURFACE_KIND, WORKBENCH_OWNER),
    ...BUILTIN_SURFACES.map((surface) => registry.register("surface", surface)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

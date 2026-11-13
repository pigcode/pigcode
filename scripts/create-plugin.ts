#!/usr/bin/env node
/**
 * 生成一个最小的 TypeScript Pigcode 插件目录；只依赖 Node 内置模块，不引入额外依赖。
 * 入口是源码，安装时 Host 会把它转成 .mjs，不需要先构建：Host / Capability 插件是 `.ts`，
 * UI 插件是 React 写的 `.tsx`，并附带打包用的构建配置。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/** 支持的插件种类；bundle 需要作者自行组合入口，不在脚手架里生成。 */
type Kind = "agent" | "capability" | "ui"
const KINDS: readonly Kind[] = ["agent", "capability", "ui"]

/** 插件标识只允许小写字母开头，避免生成非法 npm 包名。 */
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/

/** 命令行用法。 */
const USAGE = `用法:
  node scripts/create-plugin.ts <dir> <kind> <name>
  pnpm create-plugin <dir> <kind> <name>

参数:
  dir   目标目录；不存在时创建，同名文件内容不同则拒绝覆盖
  kind  agent | capability | ui
  name  插件标识（小写字母开头，可含数字、点、下划线、连字符）

示例:
  node scripts/create-plugin.ts /tmp/pigcode-plugin-demo ui demo`

/** 生成的 package.json；pigcode 字段与 @pigcode/plugin-sdk 的 manifest 一致。 */
interface GeneratedManifest {
  name: string
  version: string
  type: "module"
  main?: string
  engines: { pigcode: string }
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  pigcode: {
    apiVersion: 1
    kind: Kind
    displayName: string
    host?: string
    client?: string
    inject: string[]
    provides: string[]
    permissions: string[]
    contributes?: Record<string, unknown>
  }
}

/**
 * UI 插件的开发依赖。React、`@types/react` 和 TypeScript 只为类型检查与本地打包：运行时拿到的是宿主的
 * 同一份实例（ADR-0002），插件不把它们打进产物。两个 `@pigcode/*` 包没有发布到 npm，所以这里不写进依赖：
 * 在仓库里开发时用根目录的 workspace 版本，在仓库外直接安装源码目录、不运行 `pnpm install` 也能用，
 * 因为运行时由宿主提供。只有要自己打包时才需要在仓库里安装依赖。
 */
const UI_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@types/react": "19.2.2",
  esbuild: "^0.28.2",
  react: "19.2.3",
  typescript: "5.9.3",
}

/** 打印错误与用法后退出；脚手架失败时不要留下半成品。 */
function fail(message: string): never {
  console.error(`错误: ${message}`)
  console.error("")
  console.error(USAGE)
  process.exit(1)
}

/** 把 demo-plugin 转成 Demo Plugin，作为默认展示名。 */
function humanize(name: string): string {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/**
 * Capability 插件提供的服务名：插件标识转成 camelCase（session-info → sessionInfo），
 * 和 Host 的服务名同一种写法。manifest 的 provides 与入口里的 ctx.provide 用的都是它。
 */
function serviceIdOf(name: string): string {
  const [first = "", ...rest] = name.split(/[._-]+/).filter(Boolean)
  return first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")
}

/** 按 kind 生成 manifest；Host 侧插件声明 main 与 host，UI 插件只声明 client。 */
function manifestFor(
  kind: Kind,
  pkgName: string,
  name: string,
  displayName: string,
): GeneratedManifest {
  const base = { name: pkgName, version: "0.1.0", type: "module" as const }
  const engines = { pigcode: ">=0.1.0-0" } // -0 才包含预发布，0.1.0-beta.2 不小于 0.1.0
  if (kind === "agent") {
    return {
      ...base,
      main: "./index.ts",
      engines,
      pigcode: {
        apiVersion: 1,
        kind,
        displayName,
        host: "./index.ts",
        inject: ["agents"],
        provides: [`agent:${name}`],
        permissions: [],
        contributes: { agent: { id: name } },
      },
    }
  }
  if (kind === "capability") {
    return {
      ...base,
      main: "./index.ts",
      engines,
      pigcode: {
        apiVersion: 1,
        kind,
        displayName,
        host: "./index.ts",
        inject: ["sessions"],
        provides: [serviceIdOf(name)],
        permissions: [],
      },
    }
  }
  // UI 插件：入口是 React 组件（.tsx）。直接装源码时由开发版在安装时编译；打包后的应用只装构建产物（adr/0006）。
  // 插件自己不依赖它们的运行时版本，只在开发时用它们做类型检查与打包。
  return {
    ...base,
    engines,
    scripts: { build: "node build.ts", typecheck: "tsc --noEmit" },
    devDependencies: { ...UI_DEV_DEPENDENCIES },
    pigcode: {
      apiVersion: 1,
      kind,
      displayName,
      client: "./client.tsx",
      inject: [],
      provides: [],
      permissions: [],
    },
  }
}

/** Agent 入口：一个把输入原样回显的最小 driver。 */
function agentEntry(pkgName: string, name: string, displayName: string): string {
  return `/** ${pkgName}：最小 Agent 插件，把用户输入原样回显。 */
import type { AgentDriver, PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "${name}"
export const inject = ["agents"]

/** 注册 agent；停用时通过 ctx.effect 注销，避免热停用后仍可被选中。 */
export function apply(ctx: PluginHostContext): void {
  const driver: AgentDriver = {
    id: "${name}",
    displayName: "${displayName}",
    features: {
      streaming: true,
      approvals: false,
      questions: false,
      plan: false,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: false,
      nativeSessionId: false,
    },
    async createSession(input) {
      return {
        // 会话 id 是 Host 数据库的主键：复用时沿用 Host 给的 id，新会话必须全局唯一。
        id: input.sessionId ?? "${name}_" + crypto.randomUUID(),
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(_session, input, runtime) {
      runtime.emit({ type: "run.started" })
      runtime.emit({ type: "message.delta", text: input.text })
      runtime.emit({ type: "message.completed", text: input.text })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose() {},
  }
  ctx.agents.register(driver)
  ctx.effect(() => () => ctx.agents.unregister("${name}"))
}
`
}

/** Capability 入口：通过 ctx.provide 暴露只读会话信息，服务名与 manifest 的 provides 一致。 */
function capabilityEntry(pkgName: string, name: string): string {
  return `/** ${pkgName}：最小 Capability 插件，以 \`${serviceIdOf(name)}\` 服务暴露当前线程的事件数量。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "${name}"
export const inject = ["sessions"]

/** 注册服务；名字和 package.json 的 provides 相同。插件卸载时 Host 会清理它注册的服务。 */
export function apply(ctx: PluginHostContext): void {
  ctx.provide("${serviceIdOf(name)}", {
    count(threadId: string): number {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
`
}

/**
 * UI 入口：一个 Panel、一个 Surface、一个设置页与一条 Command，全部用宿主的 React 和
 * `@pigcode/ui-primitives` 写（ADR-0002），和宿主界面是同一套组件。`.tsx` 安装时由 Host 编译，
 * 不需要单独构建；要自己打包时，把 esbuild 配置里的宿主共享模块标为 external。
 */
function uiEntry(pkgName: string, name: string, displayName: string): string {
  return `/** ${pkgName}：最小 UI 插件，在左侧栏添加一个 Panel、在右侧面板添加一种 Surface、在设置里添加一页，再加一条命令。 */
import { useState } from "react"
import {
  Badge,
  Button,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
  useTheme,
} from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

/** 插件自己的文案按界面语言选择；组件里不写死界面文字。 */
const TEXT = {
  "zh-CN": {
    hello: "来自 ${pkgName} 的问候",
    theme: "主题",
    locale: "语言",
    clicks: (count: number) => \`点了 \${count} 次\`,
    increment: "点我加一",
    verbose: "详细日志",
  },
  "en-US": {
    hello: "Hello from ${pkgName}",
    theme: "Theme",
    locale: "Language",
    clicks: (count: number) => \`Clicked \${count} times\`,
    increment: "Click me",
    verbose: "Verbose logging",
  },
}

/** 按界面语言取一份文案。 */
function copyFor(locale: string) {
  return locale.startsWith("en") ? TEXT["en-US"] : TEXT["zh-CN"]
}

/** Panel 和 Surface 共用的内容：宿主的 ListRow、Badge 与 Button，主题和语言来自宿主的 hook。 */
function DemoContent() {
  const { locale } = useLocale()
  const theme = useTheme()
  const text = copyFor(locale)
  const [count, setCount] = useState(0)
  return (
    <>
      <p className="hint">{text.hello}</p>
      <ListRow title={text.theme} meta={<Badge variant="primary">{theme}</Badge>} />
      <ListRow title={text.locale} meta={<Badge>{locale}</Badge>} />
      <Button variant="primary" onClick={() => setCount((value) => value + 1)}>
        {text.clicks(count)}
      </Button>
    </>
  )
}

/** 设置页：和宿主设置页一样用分组与设置行。 */
function DemoSettings() {
  const { locale } = useLocale()
  const theme = useTheme()
  const text = copyFor(locale)
  const [verbose, setVerbose] = useState(false)
  return (
    <SettingSection>
      <SettingRow title={text.theme} value={<Badge variant="primary">{theme}</Badge>} />
      <SettingRow title={text.locale} value={<Badge>{locale}</Badge>} />
      <SettingRow title={text.verbose}>
        <Switch checked={verbose} onCheckedChange={setVerbose} aria-label={text.verbose} />
      </SettingRow>
    </SettingSection>
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  const disposePanel = ctx.panels.register({
    id: "${name}-panel",
    title: "${displayName}",
    Component: DemoContent,
  })
  // 命令面板与输入框的 / 共用这一条；slash 给了触发名。
  const disposeCommand = ctx.commands.register({
    id: "${name}-run",
    title: "${displayName}",
    slash: "${name}",
    run() {
      console.info("${pkgName} ran")
    },
  })
  const disposeSurface = ctx.surfaces.register({
    id: "${name}-surface",
    title: "${displayName}",
    Component: DemoContent,
  })
  const disposeSettings = ctx.settingsPages.register({
    id: "${name}-settings",
    title: "${displayName}",
    Component: DemoSettings,
  })
  return () => {
    disposePanel()
    disposeCommand()
    disposeSurface()
    disposeSettings()
  }
}
`
}

/** 插件目录自带的类型声明：补上 ui-primitives 用到的 Vite 环境与 preload 全局，`tsc` 才检查得动入口。 */
function uiAmbientTypes(): string {
  return `/** 插件自带的类型补充：ui-primitives 的类型引用了这里声明的全局。 */
interface Window {
  /** preload 暴露的最小原生桥；插件不直接访问 Node。 */
  pigcodeNative?: { platform: string }
}
interface ImportMetaEnv {
  readonly DEV: boolean
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
declare module "*?raw" {
  const content: string
  export default content
}
`
}

/**
 * UI 插件自带构建配置：用它打包成 `dist/client.js`，宿主的共享模块（React、JSX runtime、
 * ui-primitives、插件 SDK）标为 external（ADR-0002）。打包后的 Pigcode 只装构建好的插件（adr/0006）；
 * 开发版仍可直接装源码目录，安装时 Host 会转换 `client.tsx`。
 */
function uiBuildScript(): string {
  return `/**
 * 打包 UI 插件：产物是 dist/client.js，宿主的共享模块保留裸 import，运行时由宿主用同一份实例提供。
 * 只有这一步需要 esbuild（devDependencies）；直接安装源码目录时不用打包，安装时 Host 会转换 client.tsx。
 * 打包后把 package.json 里的 pigcode.client 指向 ./dist/client.js。
 */
import { build } from "esbuild"

await build({
  entryPoints: ["client.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  external: [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "@pigcode/ui-primitives",
    "@pigcode/plugin-sdk",
  ],
})
`
}

/** UI 插件的类型配置：React JSX、严格模式；`tsc --noEmit` 就能检查入口与组件。 */
function uiTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        jsx: "react-jsx",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ["client.tsx", "env.d.ts"],
    },
    null,
    2,
  )}\n`
}

/** 写入生成文件；同名文件内容一致时跳过，内容不同则拒绝覆盖。 */
async function writeGenerated(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === content) return
    fail(`目标文件已存在且内容不同: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await writeFile(path, content, "utf8")
}

/** 按 kind 写入 manifest 与入口文件，返回生成的文件名。 */
async function writeFiles(
  target: string,
  kind: Kind,
  pkgName: string,
  name: string,
  displayName: string,
): Promise<string[]> {
  const manifest = manifestFor(kind, pkgName, name, displayName)
  await writeGenerated(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  if (kind === "ui") {
    // UI 插件是 React 插件：入口、构建配置与类型配置都一起生成，生成后直接能装、也能自己打包。
    await writeGenerated(join(target, "client.tsx"), uiEntry(pkgName, name, displayName))
    await writeGenerated(join(target, "build.ts"), uiBuildScript())
    await writeGenerated(join(target, "tsconfig.json"), uiTsconfig())
    await writeGenerated(join(target, "env.d.ts"), uiAmbientTypes())
    return ["package.json", "client.tsx", "build.ts", "tsconfig.json", "env.d.ts"]
  }
  const [file, content] =
    kind === "agent"
      ? ["index.ts", agentEntry(pkgName, name, displayName)]
      : ["index.ts", capabilityEntry(pkgName, name)]
  await writeGenerated(join(target, file), content)
  return ["package.json", file]
}

/** 打印生成结果与安装方式；安装路径就是刚生成的目录。 */
function printResult(target: string, kind: Kind, pkgName: string, files: string[]): void {
  console.log(`已生成 ${kind} 插件: ${target}`)
  console.log(`  包名: ${pkgName}`)
  for (const file of files) console.log(`  - ${file}`)
  console.log("")
  console.log("安装路径（本地目录）:")
  console.log(`  ${target}`)
  console.log("")
  console.log("安装方式:")
  if (kind === "agent") {
    console.log("  桌面端: 设置 → Agent → 安装 agent，填入上面的路径")
  } else {
    console.log("  桌面端: 设置 → 插件 → 在“插件目录或 npm 包”中填入上面的路径")
  }
  console.log(`  RPC:    plugin.installLocal { "sourceDir": "${target}" }`)
  if (kind === "ui") {
    console.log("")
    console.log(
      "UI 插件用宿主的 React 和 @pigcode/ui-primitives 写界面，安装时由 Host 编译 client.tsx。",
    )
    console.log(
      "装进打包后的 Pigcode 前要先构建（pnpm install && pnpm build），入口改指 ./dist/client.js；源码目录只在开发版可装（adr/0006）。",
    )
  }
}

/** 入口：校验参数、生成目录并打印安装路径。 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE)
    return
  }
  const [dir, kind, name] = args
  if (args.length !== 3 || !dir || !kind || !name) fail("需要且只需要 3 个参数")
  if (!KINDS.includes(kind as Kind)) fail(`不支持的插件种类: ${kind}`)
  if (!NAME_PATTERN.test(name)) fail(`非法的插件标识: ${name}`)

  const target = resolve(dir)
  const displayName = humanize(name)
  const pkgName = `pigcode-${kind}-${name}`
  await mkdir(target, { recursive: true })
  const files = await writeFiles(target, kind as Kind, pkgName, name, displayName)
  printResult(target, kind as Kind, pkgName, files)
}

await main()

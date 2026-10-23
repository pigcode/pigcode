#!/usr/bin/env node
/**
 * 生成一个最小的 TypeScript Pigcode 插件目录；只依赖 Node 内置模块，不引入额外依赖。
 * 入口是 .ts 源码，安装时 Host 会把它转成 .mjs，不需要单独的构建步骤。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/** 支持的插件种类；bundle 需要作者自行组合入口，不在脚手架里生成。 */
type Kind = "provider" | "capability" | "ui"
const KINDS: readonly Kind[] = ["provider", "capability", "ui"]

/** 插件标识只允许小写字母开头，避免生成非法 npm 包名。 */
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/

/** 命令行用法。 */
const USAGE = `用法:
  node scripts/create-plugin.ts <dir> <kind> <name>
  pnpm create-plugin <dir> <kind> <name>

参数:
  dir   目标目录；不存在时创建，同名文件内容不同则拒绝覆盖
  kind  provider | capability | ui
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

/** 按 kind 生成 manifest；Host 侧插件声明 main 与 host，UI 插件只声明 client。 */
function manifestFor(
  kind: Kind,
  pkgName: string,
  name: string,
  displayName: string,
): GeneratedManifest {
  const base = { name: pkgName, version: "0.1.0", type: "module" as const }
  const engines = { pigcode: ">=0.1.0" }
  if (kind === "provider") {
    return {
      ...base,
      main: "./index.ts",
      engines,
      pigcode: {
        apiVersion: 1,
        kind,
        displayName,
        host: "./index.ts",
        inject: ["providers"],
        provides: [`provider:${name}`],
        permissions: [],
        contributes: { provider: { id: name } },
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
        provides: [`capability:${name}`],
        permissions: [],
      },
    }
  }
  return {
    ...base,
    engines,
    pigcode: {
      apiVersion: 1,
      kind,
      displayName,
      client: "./client.ts",
      inject: [],
      provides: [],
      permissions: [],
    },
  }
}

/** provider 入口：一个把输入原样回显的最小 driver。 */
function providerEntry(pkgName: string, name: string, displayName: string): string {
  return `/** ${pkgName}：最小 agent（provider）插件，把用户输入原样回显。 */
import type { PluginHostContext, ProviderPluginDriver } from "@pigcode/plugin-sdk"

export const name = "${name}"
export const inject = ["providers"]

/** 注册 provider；停用时通过 ctx.effect 注销，避免热停用后仍可被选中。 */
export function apply(ctx: PluginHostContext): void {
  const driver: ProviderPluginDriver = {
    id: "${name}",
    displayName: "${displayName}",
    capabilities: {
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
  ctx.providers.register(driver)
  ctx.effect(() => () => ctx.providers.unregister("${name}"))
}
`
}

/** capability 入口：通过 ctx.provide 暴露只读会话信息。 */
function capabilityEntry(pkgName: string, name: string): string {
  return `/** ${pkgName}：最小 capability 插件，暴露当前线程的事件数量。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "${name}"
export const inject = ["sessions"]

/** 注册 capability；插件卸载时 Host 会清理它注册的服务。 */
export function apply(ctx: PluginHostContext): void {
  ctx.provide("${name}", {
    count(threadId: string): number {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
`
}

/** UI 入口：一个侧栏面板与一个右栏标签，用 ctx.ui 拼出和宿主一致的界面，不依赖 React。 */
function uiEntry(pkgName: string, name: string, displayName: string): string {
  return `/** ${pkgName}：最小 UI 插件，在侧栏添加一个面板、在右栏添加一种标签。 */
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

export function apply(ctx: ClientPluginContext): () => void {
  const disposePanel = ctx.registerPanel({
    id: "${name}-panel",
    title: "${displayName}",
    render(container) {
      container.append(ctx.ui.text("Hello from ${pkgName}", { tone: "muted", size: "sm" }))
    },
  })
  const disposeSurface = ctx.registerSurface({
    id: "${name}-surface",
    title: "${displayName}",
    render(container) {
      container.append(
        ctx.ui.section({
          title: "${displayName}",
          children: [ctx.ui.row({ title: "Theme", control: ctx.ui.badge(ctx.theme.get()) })],
        }),
      )
    },
  })
  return () => {
    disposePanel()
    disposeSurface()
  }
}
`
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
  const [file, content] =
    kind === "provider"
      ? ["index.ts", providerEntry(pkgName, name, displayName)]
      : kind === "capability"
        ? ["index.ts", capabilityEntry(pkgName, name)]
        : ["client.ts", uiEntry(pkgName, name, displayName)]
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
  if (kind === "provider") {
    console.log("  桌面端: 设置 → Agent → 安装 agent，填入上面的路径")
  } else {
    console.log("  桌面端: 设置 → 插件 → 在“插件目录或 npm 包”中填入上面的路径")
  }
  console.log(`  RPC:    plugin.installLocal { "sourceDir": "${target}" }`)
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

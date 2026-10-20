#!/usr/bin/env node
/** 生成一个最小 Pigcode 插件目录；只依赖 Node 内置模块，不引入额外依赖。 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/** 支持的插件种类；bundle 需要作者自行组合入口，不在脚手架里生成。 */
const KINDS = new Set(["provider", "capability", "ui"])

/** 插件标识只允许小写字母开头，避免生成非法 npm 包名。 */
const NAME_PATTERN = /^[a-z][a-z0-9._-]*$/

/** 命令行用法。 */
const USAGE = `用法:
  node scripts/create-plugin.mjs <dir> <kind> <name>
  pnpm create-plugin <dir> <kind> <name>

参数:
  dir   目标目录；不存在时创建，同名文件内容不同则拒绝覆盖
  kind  provider | capability | ui
  name  插件标识（小写字母开头，可含数字、点、下划线、连字符）

示例:
  node scripts/create-plugin.mjs /tmp/pigcode-plugin-demo ui demo`

/** 打印错误与用法后退出；脚手架失败时不要留下半成品。 */
function fail(message) {
  console.error(`错误: ${message}`)
  console.error("")
  console.error(USAGE)
  process.exit(1)
}

/** 把 demo-plugin 转成 Demo Plugin，作为默认展示名。 */
function humanize(name) {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/** 生成 package.json 的公共部分；各 kind 再补充自己的入口与声明。 */
function baseManifest(pkgName, displayName, kind, main) {
  const manifest = { name: pkgName, version: "0.1.0", type: "module" }
  if (main) manifest.main = main
  manifest.engines = { pigcode: ">=0.1.0" }
  manifest.pigcode = { apiVersion: 1, kind, displayName }
  return manifest
}

/** provider 插件的 manifest；声明 provider 能力便于冲突检测。 */
function providerManifest(pkgName, name, displayName) {
  const manifest = baseManifest(pkgName, displayName, "provider", "./index.mjs")
  Object.assign(manifest.pigcode, {
    host: "./index.mjs",
    inject: ["providers"],
    provides: [`provider:${name}`],
    permissions: [],
    contributes: { provider: { id: name } },
  })
  return manifest
}

/** capability 插件的 manifest；只声明只读 sessions 依赖。 */
function capabilityManifest(pkgName, name, displayName) {
  const manifest = baseManifest(pkgName, displayName, "capability", "./index.mjs")
  Object.assign(manifest.pigcode, {
    host: "./index.mjs",
    inject: ["sessions"],
    provides: [`capability:${name}`],
    permissions: [],
  })
  return manifest
}

/** UI 插件的 manifest；只声明 client 入口，不加载 Host 代码。 */
function uiManifest(pkgName, displayName) {
  const manifest = baseManifest(pkgName, displayName, "ui")
  Object.assign(manifest.pigcode, {
    client: "./client.mjs",
    inject: [],
    provides: [],
    permissions: [],
  })
  return manifest
}

/** provider 入口：一个把输入原样回显的最小 driver。 */
function providerEntry(pkgName, name, displayName) {
  return `/** ${pkgName}：最小 provider 插件，把用户输入原样回显。 */
export const name = "${name}"
export const inject = ["providers"]

/** 注册 provider；停用时通过 ctx.effect 注销，避免热停用后仍可被选中。 */
export function apply(ctx) {
  const driver = {
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
        id: "${name}_" + input.threadId,
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
function capabilityEntry(pkgName, name) {
  return `/** ${pkgName}：最小 capability 插件，暴露当前线程的事件数量。 */
export const name = "${name}"
export const inject = ["sessions"]

/** 注册 capability；插件卸载时 Host 会清理它注册的服务。 */
export function apply(ctx) {
  ctx.provide("${name}", {
    count(threadId) {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
`
}

/** UI 入口：注册一个纯 DOM 侧栏面板，不依赖 React。 */
function uiEntry(pkgName, name, displayName) {
  return `/** ${pkgName}：最小 UI 插件，在侧栏添加一个只读面板。 */
export function apply(ctx) {
  return ctx.registerPanel({
    id: "${name}-panel",
    title: "${displayName}",
    render(container) {
      container.textContent = "Hello from ${pkgName}"
    },
  })
}
`
}

/** 写入生成文件；同名文件内容一致时跳过，内容不同则拒绝覆盖。 */
async function writeGenerated(path, content) {
  try {
    if ((await readFile(path, "utf8")) === content) return
    fail(`目标文件已存在且内容不同: ${path}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await writeFile(path, content, "utf8")
}

/** 创建目标目录；已存在时直接复用。 */
async function prepareDir(target) {
  await mkdir(target, { recursive: true })
}

/** 写入 JSON 文件；统一缩进与结尾换行，方便再次格式化。 */
async function writeJson(path, value) {
  await writeGenerated(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 按 kind 生成入口文件并返回生成的文件名。 */
async function writeFiles(target, kind, pkgName, name, displayName) {
  const manifest =
    kind === "provider"
      ? providerManifest(pkgName, name, displayName)
      : kind === "capability"
        ? capabilityManifest(pkgName, name, displayName)
        : uiManifest(pkgName, displayName)
  await writeJson(join(target, "package.json"), manifest)

  if (kind === "provider") {
    await writeGenerated(join(target, "index.mjs"), providerEntry(pkgName, name, displayName))
    return ["package.json", "index.mjs"]
  }
  if (kind === "capability") {
    await writeGenerated(join(target, "index.mjs"), capabilityEntry(pkgName, name))
    return ["package.json", "index.mjs"]
  }
  await writeGenerated(join(target, "client.mjs"), uiEntry(pkgName, name, displayName))
  return ["package.json", "client.mjs"]
}

/** 打印生成结果与安装方式；安装路径就是刚生成的目录。 */
function printResult(target, kind, pkgName, files) {
  console.log(`已生成 ${kind} 插件: ${target}`)
  console.log(`  包名: ${pkgName}`)
  for (const file of files) console.log(`  - ${file}`)
  console.log("")
  console.log("安装路径（本地目录）:")
  console.log(`  ${target}`)
  console.log("")
  console.log("安装方式:")
  console.log("  桌面端: 设置 → 插件 → 在“插件目录或 npm 包”中填入上面的路径")
  console.log(`  RPC:    plugin.installLocal { "sourceDir": "${target}" }`)
}

/** 入口：校验参数、生成目录并打印安装路径。 */
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE)
    return
  }
  if (args.length !== 3) fail("需要且只需要 3 个参数")

  const [dir, kind, name] = args
  if (!KINDS.has(kind)) fail(`不支持的插件种类: ${kind}`)
  if (!NAME_PATTERN.test(name)) fail(`非法的插件标识: ${name}`)

  const target = resolve(dir)
  const displayName = humanize(name)
  const pkgName = `pigcode-${kind}-${name}`
  await prepareDir(target)
  const files = await writeFiles(target, kind, pkgName, name, displayName)
  printResult(target, kind, pkgName, files)
}

await main()

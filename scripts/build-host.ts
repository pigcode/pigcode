/**
 * 把 Host utilityProcess 入口、核心服务、内置 agent 插件与 stdio MCP 桥打成可加载的 ESM bundle，
 * 并生成随应用发布的核心 profile。
 *
 * `--watch`（scripts/dev.ts 用）：构建完以后继续监听这些 bundle 用到的源码。一处改动会让所有 bundle
 * 一起重新构建，全部成功才改写一次 `out/host/build-id`，开发中的 main 看到它变了会重启 Host。
 * 插件 manifest 与核心 profile 只在启动时写一次。
 */
import { watch } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  build,
  context,
  type BuildContext,
  type BuildFailure,
  type BuildOptions,
  type BuildResult,
} from "esbuild"

/** 仓库根目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))
/** Host 构建产物目录。 */
const outDir = join(root, "apps/desktop/out/host")

/** 应用版本：唯一的版本号来源是 apps/desktop/package.json，构建时注入 Host（adr/0007）。 */
const appVersion = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"))
  .version as string

/** 共用 esbuild 选项；CJS 依赖需要 require 才能加载 Node 内置模块。 */
const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node-pty 含原生二进制，交给打包阶段处理，不能打进 bundle。
  // esbuild 自带平台二进制，并且会检查自己是否被打包（打包后找不到同目录的 bin），必须保持 external；
  // 它在 apps/desktop 的 dependencies 里，随应用一起发布。
  external: ["better-sqlite3", "node-pty", "esbuild"],
  sourcemap: true,
  // 产品版本在代码里只写一次：构建时替换成 package.json 里的值。
  define: { __PIGCODE_VERSION__: JSON.stringify(appVersion) },
  outExtension: { ".js": ".mjs" },
  banner: {
    js: 'import { createRequire as __pigcodeCreateRequire } from "node:module"; const require = __pigcodeCreateRequire(import.meta.url);',
  },
}

/** 核心服务作为独立条目，供 profile 以相对 URL 加载；顺序即加载顺序。 */
const coreEntries: Record<string, string> = {
  storage: join(root, "apps/host/src/services/storage.ts"),
  settings: join(root, "apps/host/src/services/settings.ts"),
  projects: join(root, "apps/host/src/services/projects.ts"),
  threads: join(root, "apps/host/src/services/threads.ts"),
  sessions: join(root, "apps/host/src/services/sessions.ts"),
  "mcp-bridge": join(root, "apps/host/src/services/mcp-bridge.ts"),
  browser: join(root, "apps/host/src/services/browser.ts"),
  agents: join(root, "apps/host/src/agents/registry.ts"),
  workspace: join(root, "apps/host/src/services/workspace.ts"),
  git: join(root, "apps/host/src/services/git.ts"),
  github: join(root, "apps/host/src/services/github.ts"),
  worktrees: join(root, "apps/host/src/services/worktrees.ts"),
  checkpoints: join(root, "apps/host/src/services/checkpoints.ts"),
  terminal: join(root, "apps/host/src/services/terminal.ts"),
  schedules: join(root, "apps/host/src/services/schedules.ts"),
}

/** 核心条目的固定配置；storage 与 settings 的路径由 Host 启动时按用户 profile 填入。 */
const coreConfig: Record<string, string[]> = {
  // 随应用发布时不注册 fake agent；E2E 用 PIGCODE_AGENT=fake 打开。
  agents: ["    config:", "      fake: false"],
}

/** 随应用内置的 agent 插件：包目录名即产物目录名。 */
const builtinPlugins = ["agent-claude", "agent-codex"]

/** 是否在构建后继续监听源码。 */
const watching = process.argv.includes("--watch")

/** 保存往往连着几次写入（编辑器、格式化）；停下这么久再构建。 */
const SETTLE_MS = 150

/** 监听模式下的 esbuild context，每个 bundle 一个。 */
const contexts: BuildContext[] = []

/** 这些 bundle 用到的源码文件（绝对路径）；只有它们变了才重新构建，界面代码的改动不会重启 Host。 */
const inputs = new Set<string>()

/** 构建一个 bundle；监听模式下只建 context，最后由 rebuildAll 一起构建。 */
async function bundle(options: BuildOptions): Promise<void> {
  if (!watching) {
    await build(options)
    return
  }
  contexts.push(await context({ ...options, metafile: true, logLevel: "warning" }))
}

/** 记下一次构建读过的源码；metafile 里的路径相对于 esbuild 的工作目录。 */
function recordInputs(result: BuildResult): void {
  for (const file of Object.keys(result.metafile?.inputs ?? {})) inputs.add(resolve(file))
}

/**
 * 所有 bundle 一起重新构建；有一个失败就返回 false，错误由 esbuild 打印。
 * 失败的构建没有 metafile，出错的文件也要记下：第一次构建就失败时，改好它才能触发重新构建。
 */
async function rebuildAll(): Promise<boolean> {
  const results = await Promise.allSettled(contexts.map((ctx) => ctx.rebuild()))
  for (const result of results) {
    if (result.status === "fulfilled") recordInputs(result.value)
    else {
      const errors = (result.reason as Partial<BuildFailure>).errors ?? []
      for (const error of errors) if (error.location) inputs.add(resolve(error.location.file))
    }
  }
  return results.every((result) => result.status === "fulfilled")
}

/** 改动到达后的一轮构建；构建期间又有改动就在结束后再来一轮。 */
const rounds = { building: false, again: false, timer: undefined as NodeJS.Timeout | undefined }

async function rebuildRound(): Promise<void> {
  if (rounds.building) {
    rounds.again = true
    return
  }
  rounds.building = true
  if (await rebuildAll()) {
    await writeFile(join(outDir, "build-id"), `${Date.now()}\n`, "utf8")
    console.log("[host] rebuilt, restarting the Host")
  } else {
    console.log("[host] rebuild failed; the running Host keeps the previous build")
  }
  rounds.building = false
  if (rounds.again) {
    rounds.again = false
    void rebuildRound()
  }
}

/** 监听源码目录；用到的文件变了，稍等再构建。 */
function watchSources(): void {
  for (const dir of [join(root, "apps"), join(root, "packages")]) {
    watch(dir, { recursive: true }, (_event, name) => {
      if (!name || !inputs.has(resolve(dir, name))) return
      clearTimeout(rounds.timer)
      rounds.timer = setTimeout(() => void rebuildRound(), SETTLE_MS)
    })
  }
}

await rm(outDir, { recursive: true, force: true })

await bundle({
  entryPoints: [join(root, "apps/host/src/entry.ts")],
  outfile: join(outDir, "index.mjs"),
  ...shared,
})
await bundle({ entryPoints: coreEntries, outdir: join(outDir, "core"), ...shared })

/**
 * 每个内置插件打成一个 index.mjs，旁边放一份 manifest：入口改指向产物，去掉只对源码有意义的
 * exports 与依赖声明。插件服务按 manifest 读取名称、设置字段与 provides。
 */
for (const name of builtinPlugins) {
  const sourceDir = join(root, "packages", name)
  const targetDir = join(outDir, "plugins", name)
  await bundle({
    entryPoints: [join(sourceDir, "src/index.ts")],
    outfile: join(targetDir, "index.mjs"),
    ...shared,
  })
  const manifest = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")) as Record<
    string,
    unknown
  > & { pigcode: Record<string, unknown> }
  const shipped: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: "module",
    main: "./index.mjs",
    engines: manifest.engines,
    pigcode: { ...manifest.pigcode, host: "./index.mjs" },
  }
  // 监听模式下 bundle 还没有构建，产物目录不一定已经建好。
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`, "utf8")
}

// stdio 桥由 Codex 以子进程启动，安装包里不带源码；单独编成 .mjs。
await bundle({
  entryPoints: [join(root, "apps/host/src/mcp/stdio-bridge.ts")],
  outfile: join(outDir, "mcp/stdio-bridge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
})

/** 与 core bundle 对应的核心 profile；相对 entry 由 loader 按 profile 目录解析。 */
const profileDir = join(outDir, "profile")
await mkdir(profileDir, { recursive: true })
await writeFile(
  join(profileDir, "desktop.yml"),
  [
    "plugins:",
    ...Object.keys(coreEntries).flatMap((name) => [
      `  - id: core.${name}`,
      `    name: ../core/${name}.mjs`,
      ...(coreConfig[name] ?? []),
    ]),
    "builtinPlugins:",
    ...builtinPlugins.map((name) => `  - ../plugins/${name}`),
    "",
  ].join("\n"),
  "utf8",
)

// 监听模式：首次构建完成再告诉 scripts/dev.ts 可以启动 Electron 了；失败也照样启动，改好以后会重启 Host。
if (watching) {
  if (!(await rebuildAll())) console.log("[host] the first build failed; fix it and save to retry")
  watchSources()
  console.log("[host] built, watching for changes")
  process.send?.({ type: "host-ready" })
}

/**
 * 把 Host utilityProcess 入口、核心服务、内置 agent 插件与 stdio MCP 桥打成可加载的 ESM bundle，
 * 并生成随应用发布的核心 profile。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type BuildOptions } from "esbuild"

/** 仓库根目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))
/** Host 构建产物目录。 */
const outDir = join(root, "apps/desktop/out/host")

/** 共用 esbuild 选项；CJS 依赖需要 require 才能加载 Node 内置模块。 */
const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node-pty 含原生二进制，交给打包阶段处理，不能打进 bundle。
  external: ["better-sqlite3", "node-pty"],
  sourcemap: true,
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

await rm(outDir, { recursive: true, force: true })

await build({
  entryPoints: [join(root, "apps/host/src/entry.ts")],
  outfile: join(outDir, "index.mjs"),
  ...shared,
})
await build({ entryPoints: coreEntries, outdir: join(outDir, "core"), ...shared })

/**
 * 每个内置插件打成一个 index.mjs，旁边放一份 manifest：入口改指向产物，去掉只对源码有意义的
 * exports 与依赖声明。插件服务按 manifest 读取名称、设置字段与 provides。
 */
for (const name of builtinPlugins) {
  const sourceDir = join(root, "packages", name)
  const targetDir = join(outDir, "plugins", name)
  await build({
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
  await writeFile(join(targetDir, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`, "utf8")
}

// stdio 桥由 Codex/Claude 以系统 node 子进程启动，不能依赖 Node 的类型剥离；单独编成 .mjs。
await build({
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

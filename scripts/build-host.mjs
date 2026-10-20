/** 把 Host utilityProcess 入口与核心服务打成可加载的 ESM bundle。 */
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// esbuild 声明在 apps/desktop 下，脚本仍从仓库根目录执行。
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url))
const { build } = require("esbuild")

/** 仓库根目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))
/** Host 构建产物目录。 */
const outDir = join(root, "apps/desktop/out/host")

/** 共用 esbuild 选项；CJS 依赖需要 require 才能加载 Node 内置模块。 */
const shared = {
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

/** 核心服务作为独立条目，供 profile 以相对 URL 加载。 */
const coreEntries = {
  storage: join(root, "apps/host/src/services/storage.ts"),
  projects: join(root, "apps/host/src/services/projects.ts"),
  threads: join(root, "apps/host/src/services/threads.ts"),
  sessions: join(root, "apps/host/src/services/sessions.ts"),
  providers: join(root, "apps/host/src/providers/registry.ts"),
  workspace: join(root, "apps/host/src/services/workspace.ts"),
  git: join(root, "apps/host/src/services/git.ts"),
  worktrees: join(root, "apps/host/src/services/worktrees.ts"),
  checkpoints: join(root, "apps/host/src/services/checkpoints.ts"),
  terminal: join(root, "apps/host/src/services/terminal.ts"),
}

await build({
  entryPoints: [join(root, "apps/host/src/entry.ts")],
  outfile: join(outDir, "index.mjs"),
  ...shared,
})
await build({ entryPoints: coreEntries, outdir: join(outDir, "core"), ...shared })

/** 与 core bundle 对应的默认 profile；相对 entry 由 loader 按 baseUrl 解析。 */
const profileDir = join(outDir, "profile")
await mkdir(profileDir, { recursive: true })
await writeFile(
  join(profileDir, "desktop.yml"),
  [
    "plugins:",
    "  - id: core.storage",
    "    name: ../core/storage.mjs",
    "    config:",
    '      path: ":memory:"',
    "  - id: core.projects",
    "    name: ../core/projects.mjs",
    "  - id: core.threads",
    "    name: ../core/threads.mjs",
    "  - id: core.sessions",
    "    name: ../core/sessions.mjs",
    "  - id: core.providers",
    "    name: ../core/providers.mjs",
    "  - id: core.workspace",
    "    name: ../core/workspace.mjs",
    "  - id: core.git",
    "    name: ../core/git.mjs",
    "  - id: core.worktrees",
    "    name: ../core/worktrees.mjs",
    "  - id: core.checkpoints",
    "    name: ../core/checkpoints.mjs",
    "  - id: core.terminal",
    "    name: ../core/terminal.mjs",
    "",
  ].join("\n"),
  "utf8",
)

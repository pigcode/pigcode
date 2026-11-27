/**
 * 构建无窗口独立 Host 部署包（`apps/host/out/headless/`），供 Linux 服务器 / NAS 或本机纯 Node 常驻部署。
 *
 * 直接通过 `buildHost({ outDir, entry: "headless", cursorRuntime: false })` 将 `headless.mjs`、
 * 核心服务、内置插件、stdio MCP 桥与 profile 输出到部署目录（不改动 `apps/desktop/out/host`），
 * 并编译独立 `bin/pigcode-host.mjs`、生成 postinstall 权限修复脚本、`package.json`、`systemd --user`
 * 单元模板与中文部署说明。
 */
import { realpathSync } from "node:fs"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { appVersion, buildHost, root } from "./build-host.ts"

/** 无窗口独立部署包输出目录（位于 .gitignore 忽略的 out/ 下）。 */
export const HEADLESS_OUT_DIR = join(root, "apps/host/out/headless")

/** `buildHeadlessHost` 的运行选项。 */
export interface BuildHeadlessHostOptions {
  /** 自定义输出目录（测试用于隔离工作区 `apps/host/out/headless`）。 */
  outDir?: string
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function requireDependencyVersion(
  deps: Record<string, string> | undefined,
  name: string,
  sourcePath: string,
): string {
  const version = deps?.[name]
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`Missing version for "${name}" in ${sourcePath}`)
  }
  return version
}

function renderFixNodePtyHelperScript(): string {
  return [
    "/**",
    " * 修复 node-pty 预编译包中 POSIX spawn-helper 缺少可执行权限的问题，避免打开终端时报错。",
    " */",
    'import { chmodSync, existsSync, readdirSync, statSync } from "node:fs"',
    'import { createRequire } from "node:module"',
    'import { dirname, join } from "node:path"',
    "",
    "function ensureExecutable(filePath) {",
    "  let info",
    "  try {",
    "    info = statSync(filePath)",
    "  } catch {",
    "    return",
    "  }",
    "  if (!info.isFile() || (info.mode & 0o111) !== 0) return",
    "  try {",
    "    chmodSync(filePath, 0o755)",
    "  } catch (error) {",
    '    const code = error && typeof error === "object" ? error.code : undefined',
    '    if (code !== "EPERM" && code !== "EROFS") throw error',
    "  }",
    "}",
    "",
    'if (process.platform !== "win32") {',
    '  const require = createRequire(new URL("../package.json", import.meta.url))',
    "  let nodePtyDir",
    "  try {",
    '    nodePtyDir = dirname(require.resolve("node-pty/package.json"))',
    "  } catch {",
    "    process.exit(0)",
    "  }",
    '  const prebuildsDir = join(nodePtyDir, "prebuilds")',
    "  if (existsSync(prebuildsDir)) {",
    "    for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {",
    "      const candidateDir = join(prebuildsDir, entry.name)",
    "      try {",
    "        if (!statSync(candidateDir).isDirectory()) continue",
    "      } catch {",
    "        continue",
    "      }",
    '      ensureExecutable(join(candidateDir, "spawn-helper"))',
    "    }",
    "  }",
    '  ensureExecutable(join(nodePtyDir, "build", "Release", "spawn-helper"))',
    "}",
    "",
  ].join("\n")
}

function renderSystemdUnit(): string {
  return [
    "[Unit]",
    "Description=Pigcode 无窗口 Host 常驻服务",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "# %h 由 systemd 展开为当前用户家目录（示例假设本包部署在 ~/.local/share/pigcode-host 并已执行 npm install --omit=dev）",
    "# WorkingDirectory 设置为家目录，实际配置与会话数据保存在 profile 目录中",
    "WorkingDirectory=%h",
    "# 若 node 不在系统默认 PATH（例如 nvm / fnm 安装），请改写为：<node绝对路径> %h/.local/share/pigcode-host/bin/pigcode-host.mjs start",
    "ExecStart=%h/.local/share/pigcode-host/bin/pigcode-host.mjs start",
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGINT",
    "TimeoutStopSec=15",
    "# 可选：通过环境变量注入 32 字节 hex 或 base64/base64url 主密钥，替代 <profileDir>/credential.key",
    "# Environment=PIGCODE_CREDENTIAL_KEY=",
    "# 可选：自定义用户配置目录（Linux 默认为 ${XDG_CONFIG_HOME:-~/.config}/Pigcode/profiles/desktop）",
    "# Environment=PIGCODE_PROFILE_DIR=%h/.config/Pigcode/profiles/desktop",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

function renderReadme(): string {
  return [
    "# Pigcode 无窗口独立 Host 部署指南",
    "",
    "本目录为脱离 Electron 窗口与图形环境的 Pigcode Host 独立运行包，适用于 Linux 电脑、NAS 或无桌面环境常驻运行。",
    "",
    "## 1. 环境要求",
    "",
    "- **Node.js `>= 22.18`**（可通过 `node -v` 确认）",
    "- **Linux / NAS 安装额外编译工具**：`make`、`python3`、`g++`",
    "",
    "## 2. 安装运行时依赖",
    "",
    "将本目录完整复制到目标电脑（例如 `~/.local/share/pigcode-host`）后，在目录内执行：",
    "",
    "```bash",
    "npm install --omit=dev",
    "```",
    "",
    "说明：",
    "- `node-pty` 官方包仅附带 macOS 与 Windows 预编译二进制，因此在 **Linux / NAS 上执行 `npm install --omit=dev` 时会自动调用目标机器的 `make`、`python3` 和 `g++` 编译 `node-pty` 原生模块**。",
    "- macOS 与 Windows 会直接使用预编译二进制，并由 `postinstall` 脚本自动修复 `spawn-helper` 的可执行权限。",
    "- `better-sqlite3`、`esbuild` 与 `@cursor/sdk`（含目标平台原生辅助二进制）也会在此步骤按当前平台安装。",
    "",
    "可选：将 `pigcode-host` 注册到 `PATH`（未执行时下文命令均可用 `./bin/pigcode-host.mjs` 替代）：",
    "",
    "```bash",
    "npm link",
    "```",
    "",
    "## 3. 配置中继与启动 Host",
    "",
    "1. 通过标准输入配置中继地址与访问令牌（避免令牌出现在命令行历史中）：",
    "",
    "```bash",
    'printf "%s\\n" "你的中继访问令牌" | pigcode-host relay set --address wss://relay.example.com --token-stdin',
    "```",
    "",
    "常用中继排查命令：",
    "",
    "```bash",
    "pigcode-host relay status",
    "pigcode-host relay clear",
    "```",
    "",
    "2. 前台启动 Host（或交由下文 `systemd --user` 托管）：",
    "",
    "```bash",
    "pigcode-host start",
    "# 如需指定数据目录或关闭局域网直连端口：",
    "# pigcode-host start --profile-dir /path/to/profile --lan-port off",
    "```",
    "",
    "查看当前运行状态：",
    "",
    "```bash",
    "pigcode-host status",
    "```",
    "",
    "## 4. SSH 终端扫码配对与设备管理",
    "",
    "在 Host 运行期间（可另开一个 SSH 终端），执行以下命令生成二维码并完成手机端配对：",
    "",
    "```bash",
    "pigcode-host pair",
    "# 如终端字体导致二维码变形，可附加 --show-raw 输出原始配对字符串",
    "# pigcode-host pair --show-raw",
    "```",
    "",
    "使用手机端扫描终端二维码，核对终端显示的 6 位确认码后输入 `y` 确认。",
    "",
    "查看与管理已配对设备：",
    "",
    "```bash",
    "pigcode-host devices",
    "pigcode-host revoke <设备编号或名称>",
    "# 非交互脚本中可加 --yes：",
    "# pigcode-host revoke <设备编号或名称> --yes",
    "```",
    "",
    "## 5. 本机凭据安全",
    "",
    "中继访问令牌、电脑 Noise 私钥与推送令牌在本地使用 AES-256-GCM 加密保存，不依赖桌面钥匙串：",
    "",
    "- **环境变量优先**：设置 `PIGCODE_CREDENTIAL_KEY`（32 字节 hex，或 32 字节 base64/base64url）后，主密钥仅保留在进程环境变量中，不落盘密钥文件。",
    "- **自动生成文件密钥**：未设置环境变量时，Host 会在 `<profileDir>/credential.key` 自动原子生成仅当前用户可读写（`0600`）的主密钥。",
    "- 请像保护 `~/.ssh` 私钥一样保护 `<profileDir>/credential.key` 与 `PIGCODE_CREDENTIAL_KEY`。",
    "",
    "## 6. 使用 `systemd --user` 常驻运行",
    "",
    "仓库附带单元模板 `examples/pigcode-host.service`。假设部署目录为 `~/.local/share/pigcode-host`：",
    "",
    "```bash",
    "mkdir -p ~/.config/systemd/user",
    "cp examples/pigcode-host.service ~/.config/systemd/user/pigcode-host.service",
    "systemctl --user daemon-reload",
    "systemctl --user enable --now pigcode-host",
    "```",
    "",
    "如希望退出 SSH 会话后服务继续常驻（需管理员支持 lingering）：",
    "",
    "```bash",
    'loginctl enable-linger "$USER"',
    "```",
    "",
    "查看运行日志：",
    "",
    "```bash",
    "journalctl --user -u pigcode-host -f",
    "```",
    "",
  ].join("\n")
}

/** 构建无窗口独立部署包（默认输出到 `apps/host/out/headless/`）。 */
export async function buildHeadlessHost(options: BuildHeadlessHostOptions = {}): Promise<void> {
  const targetOutDir = options.outDir ?? HEADLESS_OUT_DIR

  await rm(targetOutDir, { recursive: true, force: true })
  await mkdir(targetOutDir, { recursive: true })

  await buildHost({
    outDir: join(targetOutDir, "host"),
    entry: "headless",
    cursorRuntime: false,
  })

  const binDir = join(targetOutDir, "bin")
  await mkdir(binDir, { recursive: true })
  const targetBin = join(binDir, "pigcode-host.mjs")
  await build({
    entryPoints: [join(root, "apps/host/bin/pigcode-host.ts")],
    outfile: targetBin,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node22",
  })
  await chmod(targetBin, 0o755)

  const scriptsDir = join(targetOutDir, "scripts")
  await mkdir(scriptsDir, { recursive: true })
  await writeFile(
    join(scriptsDir, "fix-node-pty-helper.mjs"),
    renderFixNodePtyHelperScript(),
    "utf8",
  )

  const hostPkgPath = join(root, "apps/host/package.json")
  const desktopPkgPath = join(root, "apps/desktop/package.json")
  const hostPkg = JSON.parse(await readFile(hostPkgPath, "utf8")) as PackageManifest
  const desktopPkg = JSON.parse(await readFile(desktopPkgPath, "utf8")) as PackageManifest

  const manifest = {
    name: "@pigcode/headless-host",
    version: appVersion,
    private: true,
    type: "module",
    engines: {
      node: ">=22.18",
    },
    bin: {
      "pigcode-host": "./bin/pigcode-host.mjs",
    },
    scripts: {
      postinstall: "node ./scripts/fix-node-pty-helper.mjs",
    },
    dependencies: {
      "@cursor/sdk": requireDependencyVersion(
        desktopPkg.dependencies,
        "@cursor/sdk",
        desktopPkgPath,
      ),
      "better-sqlite3": requireDependencyVersion(
        hostPkg.dependencies,
        "better-sqlite3",
        hostPkgPath,
      ),
      esbuild: requireDependencyVersion(hostPkg.devDependencies, "esbuild", hostPkgPath),
      "node-pty": requireDependencyVersion(hostPkg.dependencies, "node-pty", hostPkgPath),
    },
  }
  await writeFile(
    join(targetOutDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  )

  const examplesDir = join(targetOutDir, "examples")
  await mkdir(examplesDir, { recursive: true })
  await writeFile(join(examplesDir, "pigcode-host.service"), renderSystemdUnit(), "utf8")
  await writeFile(join(targetOutDir, "README.md"), renderReadme(), "utf8")
}

function normalizeForCompare(target: string): string {
  let resolved: string
  try {
    resolved = realpathSync(target)
  } catch {
    resolved = resolve(target)
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isDirectEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return normalizeForCompare(entry) === normalizeForCompare(fileURLToPath(import.meta.url))
}

if (isDirectEntry()) {
  await buildHeadlessHost()
}

/** 验证 npm/tarball 安装走注入的 pnpm runner，本地目录仍走复制。 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installPlugin, listPlugins, type PnpmRunner } from "./plugin-manager"

/** 构造一个合法的 Agent 插件包 manifest。 */
function agentManifest(name: string): Record<string, unknown> {
  return {
    name,
    version: "0.1.0",
    type: "module",
    main: "./index.mjs",
    pigcode: {
      apiVersion: 1,
      kind: "agent",
      displayName: "Echo",
      host: "./index.mjs",
      provides: ["agent:echo"],
      permissions: [],
    },
  }
}

/** 读取 profile 的 package.json；文件不存在或不可解析时返回空对象。 */
async function readProfilePackage(
  profileDir: string,
): Promise<{ dependencies?: Record<string, string> }> {
  try {
    return JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
  } catch {
    return {}
  }
}

/** 模拟 pnpm add 的落盘结果：写入依赖声明与 node_modules 中的包。 */
async function writeNpmInstall(profileDir: string, name: string): Promise<void> {
  const existing = await readProfilePackage(profileDir)
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "pigcode-profile",
      version: "0.0.0",
      private: true,
      dependencies: { ...existing.dependencies, [name]: "0.1.0" },
    }),
  )
  const target = join(profileDir, "node_modules", name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, "package.json"), JSON.stringify(agentManifest(name)))
  await writeFile(join(target, "index.mjs"), "export function apply() {}\n")
}

describe("plugin install", () => {
  it("installs from an npm spec using the injected runner", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-install-"))
    const calls: string[][] = []
    const runner: PnpmRunner = async (args) => {
      calls.push(args)
      await writeNpmInstall(profileDir, "pigcode-agent-echo")
    }

    const entry = await installPlugin(profileDir, "pigcode-agent-echo@0.1.0", runner)

    expect(calls[0]).toEqual(["add", "pigcode-agent-echo@0.1.0", "--dir", profileDir])
    expect(entry).toEqual({
      id: "agent.pigcode-agent-echo",
      name: "pigcode-agent-echo",
      config: {},
      disabled: false,
    })
    expect((await listPlugins(profileDir)).map((plugin) => plugin.name)).toEqual([
      "pigcode-agent-echo",
    ])
  })

  it("installs a tarball through pnpm instead of copying it", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-install-"))
    const tarball = join(profileDir, "pigcode-agent-echo-0.1.0.tgz")
    await writeFile(tarball, "")
    const calls: string[][] = []
    const runner: PnpmRunner = async (args) => {
      calls.push(args)
      await writeNpmInstall(profileDir, "pigcode-agent-echo")
    }

    const entry = await installPlugin(profileDir, tarball, runner)

    expect(calls[0]).toEqual(["add", tarball, "--dir", profileDir])
    expect(entry.name).toBe("pigcode-agent-echo")
  })

  it("copies a local directory installed with the file: prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-install-"))
    const profileDir = join(root, "profile")
    const source = join(root, "src-plugin")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "package.json"), JSON.stringify(agentManifest("pigcode-local")))
    await writeFile(join(source, "index.mjs"), "export function apply() {}\n")

    const entry = await installPlugin(profileDir, `file:${source}`, async () => {
      throw new Error("pnpm must not run for a local directory")
    })

    expect(entry).toEqual({
      id: "agent.pigcode-local",
      name: "pigcode-local",
      config: {},
      disabled: false,
    })
  })

  it("treats Windows absolute paths from the folder picker as local directories", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-install-"))
    const runner: PnpmRunner = async () => {
      throw new Error("pnpm must not run for a local directory")
    }
    // 目录在这台机器上不存在：走本地安装会因找不到 package.json 失败，而不是交给 pnpm。
    // Windows 上访问 UNC 路径会去找网络主机，只在别的平台上验证它。
    const specs = ["C:\\plugins\\echo"]
    if (process.platform !== "win32") specs.push("\\\\server\\share\\echo")
    for (const spec of specs) {
      await expect(installPlugin(profileDir, spec, runner)).rejects.toThrow(/ENOENT/)
    }
  })

  it("selects the newly added dependency instead of the last one in package.json", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "pigcode-install-"))
    // pnpm 会按字母序维护依赖；即使旧依赖排在后面，也必须选中本次新增的包。
    await writeFile(
      join(profileDir, "package.json"),
      JSON.stringify({
        name: "pigcode-profile",
        version: "0.0.0",
        private: true,
        dependencies: { "zzz-existing": "1.0.0" },
      }),
    )
    const runner: PnpmRunner = async () => {
      await writeFile(
        join(profileDir, "package.json"),
        JSON.stringify({
          name: "pigcode-profile",
          version: "0.0.0",
          private: true,
          dependencies: {
            "pigcode-agent-echo": "0.1.0",
            "zzz-existing": "1.0.0",
          },
        }),
      )
      const target = join(profileDir, "node_modules", "pigcode-agent-echo")
      await mkdir(target, { recursive: true })
      await writeFile(
        join(target, "package.json"),
        JSON.stringify(agentManifest("pigcode-agent-echo")),
      )
      await writeFile(join(target, "index.mjs"), "export function apply() {}\n")
    }

    const entry = await installPlugin(profileDir, "pigcode-agent-echo@0.1.0", runner)

    expect(entry.name).toBe("pigcode-agent-echo")
  })
})

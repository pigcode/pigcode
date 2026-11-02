/**
 * 从上一个版本升级：用旧版本的迁移造出数据库，写入旧名字的 settings.json 与 plugins.yml，
 * 按 entry.ts 的顺序启动 Host（核心服务 → 重启恢复 → 插件服务 → loadAll），检查数据都在、
 * 旧名字都迁移了、数据库有备份；第二次启动什么都不改。
 */
import Loader from "@cordisjs/plugin-loader"
import Database from "better-sqlite3"
import { Context } from "cordis"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"
import { apply as agentsPlugin } from "../agents/registry"
import { installLocalPlugin } from "../services/plugin-manager"
import { apply as pluginsPlugin } from "../services/plugins"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { migrate } from "../storage/migrations"

/** 随应用内置的两个 Agent 插件，按 profile 里的顺序。 */
const BUILTIN = ["agent-claude", "agent-codex"]
const ECHO_SOURCE = fileURLToPath(new URL("../../../../examples/agent-echo", import.meta.url))
const NOW = "2026-10-30T00:00:00.000Z"

/**
 * 像 build-host.ts 那样摆出内置插件：manifest 用仓库里的 package.json，Host 入口换成一个 .mjs，
 * 只注册一个和真插件同 id 的 driver（真 driver 的 TypeScript 源码不经构建没法由 loader 直接加载）。
 */
async function writeBuiltins(root: string): Promise<string[]> {
  const dirs: string[] = []
  for (const name of BUILTIN) {
    const source = fileURLToPath(
      new URL(`../../../../packages/${name}/package.json`, import.meta.url),
    )
    const manifest = JSON.parse(await readFile(source, "utf8")) as {
      pigcode: { host: string; contributes: { agent: { id: string } } }
    }
    const id = manifest.pigcode.contributes.agent.id
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    manifest.pigcode.host = "./index.mjs"
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
    await writeFile(
      join(dir, "index.mjs"),
      [
        'export const inject = ["agents"]',
        "export function apply(ctx) {",
        `  ctx.agents.register({ id: "${id}", displayName: "${id}", features: {},`,
        "    createSession: async () => ({}), send: async () => {},",
        "    interrupt: async () => {}, dispose: async () => {} })",
        `  ctx.effect(() => () => ctx.agents.unregister("${id}"))`,
        "}",
        "",
      ].join("\n"),
    )
    dirs.push(dir)
  }
  return dirs
}

/** 改名以前的版本（schema v6、旧名字）留在用户 profile 里的数据，包括旧字段名的事件。 */
async function writeOldProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pigcode-upgrade-"))
  const profileDir = join(root, "profile")
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({ name: "pigcode-profile", version: "0.0.0", private: true }),
  )
  // 插件包的文件和版本无关；装好以后把 plugins.yml 改回旧版本写的样子。
  await installLocalPlugin(profileDir, ECHO_SOURCE)
  await writeFile(
    join(profileDir, "plugins.yml"),
    stringify({
      plugins: [
        {
          id: "provider.pigcode-agent-echo",
          name: "pigcode-agent-echo",
          config: {},
          disabled: false,
        },
        {
          id: "provider.@pigcode/provider-claude",
          name: "@pigcode/provider-claude",
          disabled: true,
          builtin: true,
        },
      ],
    }),
  )
  await writeFile(
    join(profileDir, "settings.json"),
    JSON.stringify({
      "providers.codex": { binaryPath: "/opt/codex", customModels: ["gpt-old"] },
      "providers.echo": { prefix: "old:" },
      "agents.defaultProvider": "echo",
      "appearance.density": "compact",
    }),
  )
  const db = new Database(join(profileDir, "pigcode.db"))
  db.pragma("journal_mode = WAL")
  migrate(db, 6)
  db.exec(`
    INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '${profileDir}', 'p', '${NOW}');
    INSERT INTO threads (id, project_id, title, default_provider_id, last_provider_id, last_model_id,
      permission_mode, created_at, updated_at) VALUES
      ('th_codex', 'pr_1', 'Codex thread', 'codex', NULL, NULL, 'workspace-write', '${NOW}', '${NOW}'),
      ('th_echo', 'pr_1', 'Switched to echo', 'codex', 'echo', NULL, 'read-only', '${NOW}', '${NOW}');
    INSERT INTO provider_sessions (id, thread_id, provider_id, native_session_id, cwd, status, created_at)
      VALUES ('ps_1', 'th_echo', 'echo', 'native-1', '${profileDir}', 'stopped', '${NOW}');
    INSERT INTO runs (id, thread_id, provider_session_id, status, started_at)
      VALUES ('run_1', 'th_echo', 'ps_1', 'completed', '${NOW}');
    INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
      VALUES
      ('th_echo', NULL, 'thread.updated', '{"providerId":"echo","modelId":null,"handoff":"summary"}', 1, '${NOW}'),
      ('th_echo', 'run_1', 'run.started', '{"providerId":"echo","providerSessionId":"ps_1"}', 1, '${NOW}'),
      ('th_echo', 'run_1', 'message.completed', '{"role":"user","text":"hi"}', 1, '${NOW}');
  `)
  db.close()
  return profileDir
}

/** 按 entry.ts 的顺序启动 Host。 */
async function start(profileDir: string): Promise<Context> {
  const builtin = await writeBuiltins(join(profileDir, "..", "builtin"))
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: `${pathToFileURL(profileDir).href}/` })
  await ctx.plugin(storage, { path: join(profileDir, "pigcode.db") })
  await ctx.plugin(settings, { path: join(profileDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agentsPlugin, { fake: false })
  ctx.agents.recoverAfterRestart()
  await ctx.plugin(pluginsPlugin, { profileDir, builtin })
  await ctx.plugins.loadAll()
  return ctx
}

/** 第二次启动前后要比较的文件内容。 */
async function snapshot(profileDir: string) {
  const files = (await readdir(profileDir)).filter((name) => !name.startsWith("pigcode.db-"))
  return {
    files: files.sort(),
    settings: await readFile(join(profileDir, "settings.json"), "utf8"),
    plugins: await readFile(join(profileDir, "plugins.yml"), "utf8"),
  }
}

describe("upgrading from the provider names", () => {
  it("keeps the data, migrates the old names, backs up the database and is a no-op the second time", async () => {
    const profileDir = await writeOldProfile()
    const ctx = await start(profileDir)

    // 项目、线程、会话都在；线程上的 agent id 能找到已注册的 driver。
    expect(ctx.projects.list().map((project) => project.id)).toEqual(["pr_1"])
    const echoThread = ctx.threads.get("th_echo")
    expect(echoThread).toMatchObject({ defaultAgentId: "codex", lastAgentId: "echo" })
    expect(ctx.threads.get("th_codex")).toMatchObject({ defaultAgentId: "codex" })
    const registered = ctx.agents.list().map((agent) => agent.id)
    expect(registered).toEqual(["codex", "echo"])
    expect(ctx.agents.listSessions("th_echo")).toMatchObject([
      { id: "ps_1", agentId: "echo", nativeSessionId: "native-1", status: "stopped" },
    ])
    // 旧版本写下的事件还在，payload 里的旧字段名改成了新的。
    expect(ctx.sessions.read("th_echo", 0).map((event) => [event.type, event.payload])).toEqual([
      ["thread.updated", { agentId: "echo", modelId: null, handoff: "summary" }],
      ["run.started", { agentId: "echo", agentSessionId: "ps_1" }],
      ["message.completed", { role: "user", text: "hi" }],
    ])
    const runs = ctx.storage.db.prepare(`SELECT id, agent_session_id FROM runs`).all()
    expect(runs).toEqual([{ id: "run_1", agent_session_id: "ps_1" }])

    // Agent 设置与默认 Agent 保留；文件里只剩新键，其他键不动。
    expect(ctx.agents.getSettings("codex")).toEqual({
      binaryPath: "/opt/codex",
      customModels: ["gpt-old"],
    })
    expect(ctx.agents.getSettings("echo")).toEqual({ prefix: "old:" })
    expect(ctx.agents.configuredDefaultAgent()).toBe("echo")
    expect(JSON.parse(await readFile(join(profileDir, "settings.json"), "utf8"))).toEqual({
      "agents.codex": { binaryPath: "/opt/codex", customModels: ["gpt-old"] },
      "agents.echo": { prefix: "old:" },
      defaultAgent: "echo",
      "appearance.density": "compact",
    })

    // 插件的启停状态保留：停用的内置 Claude Code 仍停用，用户装的 echo 仍启用。
    const plugins = await ctx.plugins.list()
    expect(plugins.map((plugin) => [plugin.id, plugin.builtin, plugin.enabled])).toEqual([
      ["agent.@pigcode/agent-claude", true, false],
      ["agent.@pigcode/agent-codex", true, true],
      ["agent.pigcode-agent-echo", false, true],
    ])
    expect(plugins.every((plugin) => plugin.error === null)).toBe(true)
    const yml = parse(await readFile(join(profileDir, "plugins.yml"), "utf8")) as {
      plugins: Array<{ id: string; name: string }>
    }
    expect(yml.plugins.map((entry) => [entry.id, entry.name])).toEqual([
      ["agent.pigcode-agent-echo", "pigcode-agent-echo"],
      ["agent.@pigcode/agent-claude", "@pigcode/agent-claude"],
    ])

    // 迁移前的数据库备份在旁边，还是 v6 的旧列名。
    const backup = new Database(join(profileDir, "pigcode.db.schema-v6.bak"), { readonly: true })
    expect(backup.pragma("user_version", { simple: true })).toBe(6)
    expect(backup.prepare(`SELECT COUNT(*) FROM threads`).pluck().get()).toBe(2)
    expect(backup.prepare(`SELECT provider_id FROM provider_sessions`).pluck().get()).toBe("echo")
    backup.close()
    await ctx.fiber.dispose()

    // 第二次启动：文件、备份和数据都不变。
    const before = await snapshot(profileDir)
    const again = await start(profileDir)
    expect(await snapshot(profileDir)).toEqual(before)
    expect(again.storage.db.pragma("user_version", { simple: true })).toBe(8)
    expect(
      again.threads
        .list()
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(["th_codex", "th_echo"])
    expect(again.agents.configuredDefaultAgent()).toBe("echo")
    expect((await again.plugins.list()).map((plugin) => plugin.enabled)).toEqual([
      false,
      true,
      true,
    ])
    await again.fiber.dispose()
  })
})

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { describe, expect, it, vi } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as pluginsPlugin } from "../services/plugins"
import { apply as projects } from "../services/projects"
import { SchedulesService, type ScheduleRunner } from "../services/schedules"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { hasDartClientEnv } from "./dart-env"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU68AAAAASUVORK5CYII=",
  "base64",
)

async function writeFixturePlugin(dir: string, name: string, version: string, displayName: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version,
      description: `${displayName} plugin`,
      pigcode: {
        apiVersion: 1,
        kind: "ui",
        displayName,
        client: "./client.js",
      },
    }),
  )
  await writeFile(join(dir, "client.js"), "export function apply() {}\n")
}

async function setupManage5BHost(root: string) {
  const profileDir = join(root, "profile")
  const builtinDir = join(root, "builtin-ui")
  const marketDir = join(root, "local-market")
  const marketPluginDir = join(marketDir, "plugins", "e2e-demo")

  await mkdir(profileDir, { recursive: true })
  await writeFixturePlugin(builtinDir, "builtin-ui", "1.0.0", "Built-in UI")
  await writeFixturePlugin(marketPluginDir, "e2e-demo", "1.0.0", "E2E Demo")
  await writeFile(join(marketDir, "icon.png"), TINY_PNG)
  await writeFile(
    join(marketDir, "marketplace.json"),
    JSON.stringify({
      name: "e2e-local",
      displayName: "本地联调市场",
      description: "Real Host E2E Marketplace",
      plugins: [
        {
          name: "e2e-demo",
          displayName: "E2E Demo",
          displayName_i18n: { "zh-CN": "联调演示插件", en: "E2E Demo" },
          description: "Demo from local marketplace",
          version: "1.0.0",
          icon: "icon.png",
          source: "./plugins/e2e-demo",
        },
      ],
    }),
  )

  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(root, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  const baseUrl = pathToFileURL(profileDir).href
  await ctx.plugin(Loader, { baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/` })
  await ctx.plugin(pluginsPlugin, { profileDir, builtin: [builtinDir] })
  await ctx.plugins.addMarketplace(marketDir)

  let runCounter = 0
  const runner: ScheduleRunner = {
    createThread: vi.fn(async (target, title) =>
      ctx.threads.create(target.projectId, title, "fake", undefined, target.execution),
    ),
    startRun: vi.fn(async () => ({ runId: `run_${++runCounter}` })),
    listRuns: vi.fn(() => []),
  }
  const schedules = new SchedulesService(ctx.storage.db, () => runner)
  ctx.provide("schedules", schedules)

  const project = ctx.projects.add(join(root, "repo"), "联调项目")
  const devices = new PairedDevices(ctx.settings)
  const deviceKey = Buffer.alloc(32, 55).toString("base64url")
  devices.save({ publicKey: deviceKey, name: "Dart 5B", platform: "ios", lastConnectedAt: 1000 })

  const wire = new MemoryTransport()
  const feed = new ThreadFeed(ctx)
  const rpc = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
    computerKey: Buffer.alloc(32, 7),
    computerName: "测试电脑",
    deviceKey,
    features: ["schedules.manage", "plugins.manage"],
    relayRevision: () => undefined,
  })
  rpc.start()

  return {
    ctx,
    project,
    marketDir,
    marketPluginDir,
    wire,
    async dispose() {
      rpc.stop()
      await ctx.fiber.dispose()
    },
  }
}

describe.skipIf(!hasDartClientEnv())(
  "mobile 5B schedules & plugins Dart client end-to-end",
  { timeout: 30_000 },
  () => {
    it("runs real Node Host <-> Dart pigcode_client loopback within single Noise frames", async () => {
      const root = await mkdtemp(join(tmpdir(), "pigcode-5b-dart-e2e-"))
      const host = await setupManage5BHost(root)

      const clientPkgDir = fileURLToPath(
        new URL("../../../mobile/packages/pigcode_client", import.meta.url),
      )
      const dart = spawn("dart", ["run", "test/manage_5b_e2e_driver.dart"], {
        cwd: clientPkgDir,
        stdio: ["pipe", "pipe", "pipe"],
      })
      dart.stdin.on("error", () => {})
      let stderr = ""
      dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })

      let framesChecked = 0
      host.wire.client.onMessage((message) => {
        assertSingleNoiseFrame(message)
        framesChecked += 1
        if (!dart.killed) {
          dart.stdin.write(`${JSON.stringify({ dir: "rpc_msg", message })}\n`)
        }
      })

      const cmdPending = new Map<
        string,
        (res: {
          ok: boolean
          data?: Record<string, unknown>
          code?: string
          error?: string
        }) => void
      >()
      const rl = createInterface({ input: dart.stdout })
      rl.on("line", (line) => {
        if (!line.trim()) return
        const msg = JSON.parse(line) as {
          dir: string
          id?: string
          method?: string
          params?: Record<string, unknown>
          cmdId?: string
          ok?: boolean
          data?: Record<string, unknown>
          code?: string
          error?: string
        }
        if (msg.dir === "rpc_req") {
          const req = { jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params ?? {} }
          assertSingleNoiseFrame(req)
          framesChecked += 1
          host.wire.client.send(req)
        } else if (msg.dir === "cmd_res" && msg.cmdId) {
          const resolve = cmdPending.get(msg.cmdId)
          if (resolve) {
            cmdPending.delete(msg.cmdId)
            resolve({
              ok: msg.ok === true,
              ...(msg.data ? { data: msg.data } : {}),
              ...(msg.code ? { code: msg.code } : {}),
              ...(msg.error ? { error: msg.error } : {}),
            })
          }
        }
      })

      function runDart(action: string, args: Record<string, unknown> = {}) {
        const cmdId = randomUUID()
        return new Promise<{
          ok: boolean
          data?: Record<string, unknown>
          code?: string
          error?: string
        }>((resolve) => {
          cmdPending.set(cmdId, resolve)
          dart.stdin.write(`${JSON.stringify({ dir: "cmd", cmdId, action, args })}\n`)
        })
      }

      try {
        // --- 1. 定时任务：创建 -> 列表 -> 更新 -> 立即运行 -> 查询历史 -> 删历史 -> 删除 ---
        const created = await runDart("schedule.create", {
          projectId: host.project.id,
          title: "每日构建巡检",
          prompt: "运行测试并汇报",
          rule: { kind: "daily", time: "09:00" },
        })
        expect(created.ok, stderr).toBe(true)
        const scheduleId = (created.data!.schedule as { id: string }).id
        expect(created.data!.summary).toBe("每天 09:00")

        const updated = await runDart("schedule.update", {
          id: scheduleId,
          title: "工作日构建巡检",
          rule: { kind: "weekdays", time: "09:30" },
          enabled: false,
        })
        expect(updated.ok, stderr).toBe(true)
        expect(updated.data!.summary).toBe("工作日 09:30")
        expect((updated.data!.schedule as { enabled: boolean }).enabled).toBe(false)

        const listedSchedules = await runDart("schedule.list")
        expect(listedSchedules.ok, stderr).toBe(true)
        expect((listedSchedules.data!.schedules as unknown[]).length).toBe(1)

        const runNow = await runDart("schedule.runNow", { id: scheduleId })
        expect(runNow.ok, stderr).toBe(true)
        expect(runNow.data).toEqual({ status: "started", runId: "run_1" })

        const runs = await runDart("schedule.runs", { id: scheduleId, limit: 10, offset: 0 })
        expect(runs.ok, stderr).toBe(true)
        expect(runs.data!.total).toBe(1)
        const runEntryId = (runs.data!.runs as Array<{ id: string }>)[0]!.id

        const delRun = await runDart("schedule.deleteRun", { id: runEntryId })
        expect(delRun.ok, stderr).toBe(true)
        expect(delRun.data).toEqual({ deleted: true })

        const delSchedule = await runDart("schedule.delete", { id: scheduleId })
        expect(delSchedule.ok, stderr).toBe(true)
        expect(delSchedule.data).toEqual({ deleted: true })

        // --- 2. 插件管理：列表 -> 内置卸载拒绝 -> 市场查询与脱敏 -> 安装 -> 启停 -> 更新 -> 卸载 ---
        const initialPlugins = await runDart("plugin.list")
        expect(initialPlugins.ok, stderr).toBe(true)
        expect((initialPlugins.data!.plugins as Array<{ id: string }>)[0]?.id).toBe("ui.builtin-ui")

        const denyBuiltinUninstall = await runDart("plugin.uninstall", { id: "ui.builtin-ui" })
        expect(denyBuiltinUninstall.ok).toBe(false)
        expect(denyBuiltinUninstall.code).toBe("PLUGIN_BUILTIN_IMMUTABLE")

        const markets = await runDart("plugin.refreshMarketplaces", { id: "e2e-local" })
        expect(markets.ok, stderr).toBe(true)
        const localMarket = (
          markets.data!.marketplaces as Array<{
            id: string
            sourceLabel: string
            plugins: Array<{ name: string; iconUrl: string | null }>
          }>
        ).find((m) => m.id === "e2e-local")!
        expect(localMarket.sourceLabel).toBe("本地联调市场")
        expect(localMarket.plugins[0]?.iconUrl).toBeNull()
        expect(JSON.stringify(markets.data)).not.toContain(host.marketDir)

        const installed = await runDart("plugin.installFromMarketplace", {
          marketplace: "e2e-local",
          name: "e2e-demo",
        })
        expect(installed.ok, stderr).toBe(true)
        expect(installed.data!.plugin).toMatchObject({
          id: "ui.e2e-demo",
          version: "1.0.0",
          originKind: "marketplace",
          marketplaceId: "e2e-local",
          canUpdate: true,
        })

        const disabled = await runDart("plugin.setEnabled", { id: "ui.e2e-demo", enabled: false })
        expect(disabled.ok, stderr).toBe(true)
        expect((disabled.data!.plugin as { enabled: boolean }).enabled).toBe(false)

        // 升级本地市场里的插件版本并经由手机端触发更新
        await writeFixturePlugin(host.marketPluginDir, "e2e-demo", "1.1.0", "E2E Demo")
        const upgraded = await runDart("plugin.update", { id: "ui.e2e-demo" })
        expect(upgraded.ok, stderr).toBe(true)
        expect((upgraded.data!.plugin as { version: string }).version).toBe("1.1.0")

        const uninstalled = await runDart("plugin.uninstall", { id: "ui.e2e-demo" })
        expect(uninstalled.ok, stderr).toBe(true)

        expect(framesChecked).toBeGreaterThanOrEqual(24)
      } finally {
        dart.stdin.write(`${JSON.stringify({ dir: "shutdown" })}\n`)
        dart.stdin.end()
        await new Promise<void>((resolve) => {
          dart.once("exit", () => resolve())
          setTimeout(() => {
            dart.kill("SIGKILL")
            resolve()
          }, 2000)
        })
        rl.close()
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  },
)

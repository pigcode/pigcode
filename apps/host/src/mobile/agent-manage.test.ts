import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileAgentMethods,
  mobileFeatures,
  type MobileAgentCreateInstanceResult,
  type MobileAgentDetectResult,
  type MobileAgentListResult,
  type MobileAgentModelsResult,
  type MobileAgentSetDefaultResult,
  type MobileAgentUpdateInstanceResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import type { AgentDriver } from "../agents/driver"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MobileAgentManage } from "./agent-manage"
import { PairedDevices } from "./paired-devices"
import { MobileRequestError } from "./request-error"
import { MobileSidebarRpc } from "./sidebar-rpc"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function createAgentHostFixture() {
  const dataDir = makeTempDir("pigcode-am-data-")
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(dataDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  // Provide minimal plugin records stub so listAgents exposes fields (secret, text, env).
  const fakeManifest = {
    name: "@pigcode/agent-demo",
    version: "1.0.0",
    pigcode: {
      apiVersion: "0.1",
      displayName: "Demo Agent",
      kind: "agent",
      provides: ["agent:demo"],
      contributes: {
        agent: {
          id: "demo",
          description: { "zh-CN": "演示 Agent", en: "Demo Agent" },
          customModels: true,
          settings: [
            { key: "apiKey", type: "secret", label: "API 密钥" },
            { key: "baseUrl", type: "text", label: "接口地址" },
            { key: "env", type: "env", label: "环境变量" },
          ],
        },
      },
    },
  }
  ctx.provide("plugins" as never, {
    records: async () => [
      { id: "@pigcode/agent-demo", builtin: true, disabled: false, manifest: fakeManifest },
    ],
    list: async () => [{ id: "@pigcode/agent-demo", error: null }],
  } as never)

  const driver: AgentDriver = {
    id: "demo",
    displayName: "Demo Agent",
    features: {
      streaming: true,
      approvals: true,
      questions: true,
      plan: true,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: true,
      nativeSessionId: false,
    },
    async detect() {
      return {
        installed: true,
        version: "2.3.4",
        authenticated: true,
        account: "Demo Pro",
        command: "/opt/homebrew/bin/demo-cli",
      }
    },
    async listModels() {
      return [
        { id: "demo-pro", displayName: "Demo Pro", isDefault: true },
        { id: "demo-lite", displayName: "Demo Lite", isDefault: false },
      ]
    },
    async createSession(input) {
      return {
        id: "s1",
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: "s1",
        permissionMode: input.permissionMode ?? "full-access",
        model: input.model ?? null,
      }
    },
    async send() {},
    async interrupt() {},
    async dispose() {},
  }
  ctx.agents.register(driver)

  const manager = new MobileAgentManage(ctx, () => {})
  return { ctx, manager }
}

function callAgent<T>(manager: MobileAgentManage, method: string, params: unknown = {}): Promise<T> {
  return manager.dispatch({ jsonrpc: "2.0", id: randomUUID(), method, params }) as Promise<T>
}

describe("MobileAgentManage", () => {
  it("lists agents, masks secrets, strips command path in detect, and manages custom/hidden models", async () => {
    const { ctx, manager } = await createAgentHostFixture()
    try {
      // Save secret on default instance via mobile.agent.updateInstance -> masks to { configured: true }.
      const updatedDefault = await callAgent<MobileAgentUpdateInstanceResult>(
        manager,
        mobileAgentMethods.updateInstance,
        {
          instanceId: "demo",
          patch: {
            values: {
              apiKey: { secret: "sk-super-secret-value" },
              baseUrl: "https://api.example.com",
              customModels: ["demo-custom-1"],
              hiddenModels: ["demo-lite"],
            },
          },
        },
      )
      expect(updatedDefault.instance.values.apiKey).toEqual({ configured: true })
      expect(updatedDefault.instance.values.baseUrl).toBe("https://api.example.com")

      const list = await callAgent<MobileAgentListResult>(manager, mobileAgentMethods.list, {})
      expect(JSON.stringify(list)).not.toContain("sk-super-secret-value")
      const demo = list.agents.find((a) => a.agentId === "demo")
      expect(demo?.instances[0]?.values.apiKey).toEqual({ configured: true })

      // Detect strips absolute command path.
      const detect = await callAgent<MobileAgentDetectResult>(manager, mobileAgentMethods.detect, {
        agentId: "demo",
      })
      expect(detect.statuses.demo).toMatchObject({
        installed: true,
        version: "2.3.4",
        authenticated: true,
        account: "Demo Pro",
      })
      expect("command" in (detect.statuses.demo as Record<string, unknown>)).toBe(false)

      // Models merges catalog + custom + hidden models.
      const models = await callAgent<MobileAgentModelsResult>(manager, mobileAgentMethods.models, {
        instanceId: "demo",
      })
      expect(models.models).toEqual(
        expect.arrayContaining([
          { id: "demo-pro", name: "Demo Pro", isCustom: false, hidden: false },
          { id: "demo-lite", name: "Demo Lite", isCustom: false, hidden: true },
          { id: "demo-custom-1", name: "demo-custom-1", isCustom: true, hidden: false },
        ]),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("enforces default instance immutability while supporting full custom instance CRUD and default selection", async () => {
    const { ctx, manager } = await createAgentHostFixture()
    try {
      // Cannot rename, disable (without accountSetup), or remove default instance.
      await expect(
        callAgent(manager, mobileAgentMethods.updateInstance, {
          instanceId: "demo",
          patch: { label: "Renamed Default" },
        }),
      ).rejects.toMatchObject({ code: "AGENT_DEFAULT_INSTANCE_IMMUTABLE" })

      await expect(
        callAgent(manager, mobileAgentMethods.updateInstance, {
          instanceId: "demo",
          patch: { enabled: false },
        }),
      ).rejects.toMatchObject({ code: "AGENT_DEFAULT_INSTANCE_IMMUTABLE" })

      await expect(
        callAgent(manager, mobileAgentMethods.removeInstance, { instanceId: "demo" }),
      ).rejects.toMatchObject({ code: "AGENT_DEFAULT_INSTANCE_IMMUTABLE" })

      // Create custom instance and toggle enabled on custom instance.
      const created = await callAgent<MobileAgentCreateInstanceResult>(
        manager,
        mobileAgentMethods.createInstance,
        {
          agentId: "demo",
          label: "公司账号",
          instanceId: "demo-work",
          accentColor: "#2563EB",
          values: {
            apiKey: { secret: "sk-work-key" },
            baseUrl: "https://work.example.com",
          },
        },
      )
      expect(created.instance.instanceId).toBe("demo-work")
      expect(created.instance.accentColor).toBe("#2563eb")
      expect(created.instance.values.apiKey).toEqual({ configured: true })

      const toggled = await callAgent<MobileAgentUpdateInstanceResult>(
        manager,
        mobileAgentMethods.updateInstance,
        { instanceId: "demo-work", patch: { enabled: false } },
      )
      expect(toggled.instance.enabled).toBe(false)
      await callAgent(manager, mobileAgentMethods.updateInstance, {
        instanceId: "demo-work",
        patch: { enabled: true },
      })

      // Duplicate instanceId rejected with AGENT_INSTANCE_ID_TAKEN.
      await expect(
        callAgent(manager, mobileAgentMethods.createInstance, {
          agentId: "demo",
          label: "重复",
          instanceId: "demo-work",
        }),
      ).rejects.toMatchObject({ code: "AGENT_INSTANCE_ID_TAKEN" })

      // Unknown setting key rejected with AGENT_SETTINGS_INVALID.
      await expect(
        callAgent(manager, mobileAgentMethods.updateInstance, {
          instanceId: "demo-work",
          patch: { values: { nonexistentKey: "boom" } },
        }),
      ).rejects.toMatchObject({ code: "AGENT_SETTINGS_INVALID" })

      // Retain secret by passing { configured: true } while updating label.
      const edited = await callAgent<MobileAgentUpdateInstanceResult>(
        manager,
        mobileAgentMethods.updateInstance,
        {
          instanceId: "demo-work",
          patch: {
            label: "公司 Pro",
            values: { apiKey: { configured: true }, baseUrl: "https://work2.example.com" },
          },
        },
      )
      expect(edited.instance.label).toBe("公司 Pro")
      expect(edited.instance.values.apiKey).toEqual({ configured: true })

      // Set default instance and then reset to automatic.
      const setDef = await callAgent<MobileAgentSetDefaultResult>(
        manager,
        mobileAgentMethods.setDefault,
        { agentId: "demo", instanceId: "demo-work" },
      )
      expect(setDef).toEqual({ defaultAgentId: "demo", defaultInstanceId: "demo-work" })

      const clearedDef = await callAgent<MobileAgentSetDefaultResult>(
        manager,
        mobileAgentMethods.setDefault,
        { agentId: null },
      )
      expect(clearedDef).toEqual({ defaultAgentId: null, defaultInstanceId: null })

      // Remove custom instance succeeds.
      const removed = await callAgent<{ removed: true; instanceId: string }>(
        manager,
        mobileAgentMethods.removeInstance,
        { instanceId: "demo-work" },
      )
      expect(removed).toEqual({ removed: true, instanceId: "demo-work" })
      await expect(
        callAgent(manager, mobileAgentMethods.removeInstance, { instanceId: "demo-work" }),
      ).rejects.toBeInstanceOf(MobileRequestError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("gates mobile.agent.* behind agents.manage capability in MobileSidebarRpc", async () => {
    const { ctx } = await createAgentHostFixture()
    try {
      const devices = new PairedDevices(ctx.settings)
      const deviceKey = Buffer.alloc(32, 9).toString("base64url")
      devices.save({
        publicKey: deviceKey,
        name: "iPhone",
        platform: "ios",
        lastConnectedAt: Date.now(),
      })
      const wire = new MemoryTransport()
      const feed = new ThreadFeed(ctx)
      const rpc = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
        computerKey: Buffer.alloc(32, 2),
        computerName: "TestMac",
        deviceKey,
        features: mobileFeatures.filter((f) => f !== "agents.manage"),
        relayRevision: () => undefined,
      })
      rpc.start()

      wire.client.send({
        jsonrpc: "2.0",
        id: "a1",
        method: mobileAgentMethods.list,
        params: {},
      })
      const reply = await wire.client.next()
      expect(reply).toEqual(
        expect.objectContaining({
          id: "a1",
          error: expect.objectContaining({ code: "METHOD_NOT_AVAILABLE" }),
        }),
      )
      rpc.stop()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import Loader from "@cordisjs/plugin-loader"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { AcpDriver } from "../../../../packages/agent-acp/src/driver"
import { apply as plugins } from "../services/plugins"
import { apply as attachments } from "../services/attachments"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as agents } from "./registry"

const fixture = String.raw`
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
const [label, resume] = process.argv.slice(2)
const sessions = new Set()
let model = label
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line)
  const result = (value) => send({ id, result: value })
  if (method === "initialize") return result({
    protocolVersion: 1, agentInfo: { name: label, version: "1.0.0" }, authMethods: [],
    agentCapabilities: resume ? { sessionCapabilities: { resume: {}, close: {} } } : {},
  })
  const configOptions = () => [{ id: "model", category: "model", name: "Model", type: "select",
    currentValue: model, options: [label, label + " Alternate"].map((value) => ({ value, name: value })),
  }]
  if (method === "session/new") {
    const sessionId = randomUUID()
    sessions.add(sessionId)
    if (resume) writeFileSync(join(params.cwd, sessionId), label)
    return result({ sessionId, configOptions: configOptions() })
  }
  if (method === "session/resume" && resume && existsSync(join(params.cwd, params.sessionId))) {
    sessions.add(params.sessionId)
    return result({ configOptions: configOptions() })
  }
  if (method === "session/set_config_option" && sessions.has(params.sessionId)) {
    model = params.value
    return result({ configOptions: configOptions() })
  }
  if (method === "session/prompt" && sessions.has(params.sessionId)) {
    send({ method: "session/update", params: { sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: {
        type: "text", text: model + ": " + params.prompt[0].text,
      } },
    } })
    return result({ stopReason: "end_turn" })
  }
  if (method === "session/close") return result({})
  send({ id, error: { code: -32601, message: "Method not found" } })
})
`

it("uses one driver for distinct ACP commands and keeps both kinds of native session usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-acp-test-"))
  const script = join(root, "acp.mjs")
  await writeFile(script, fixture)
  const ctx = new Context()
  const driver = new AcpDriver()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
    ctx.agents.register(driver)
    expect(ctx.agents.listInstances("acp")).toEqual([])
    for (const [label, argv] of [
      ["Live only", [script, "Live only"]],
      ["Restorable", [script, "Restorable", "resume"]],
    ] as const) {
      const instance = ctx.agents.createInstance("acp", label, {
        values: { binaryPath: process.execPath, arguments: [...argv] },
      })
      const [model] = await ctx.agents.models("acp", instance.instanceId)
      expect(model?.id).toBe(label)
      const project = ctx.projects.add(root)
      const thread = ctx.threads.create(project.id, label, "acp", undefined, {
        instanceId: instance.instanceId,
      })
      await (
        await ctx.agents.startRun(thread.id, "first")
      ).done
      await ctx.agents.switchAgent(thread.id, "acp", label + " Alternate", instance.instanceId)
      await (
        await ctx.agents.startRun(thread.id, "second")
      ).done
      expect(ctx.agents.listSessions(thread.id)).toHaveLength(1)
      expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
        expect.objectContaining({
          type: "message.completed",
          payload: { role: "assistant", text: label + " Alternate: second" },
        }),
      )
    }
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it.skipIf(process.platform === "win32")(
  "installs a pinned Registry runtime and uses it from the same ACP driver",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-acp-registry-test-"))
    const archive = join(root, "fixture.tar.gz")
    await writeFile(join(root, "fixture"), "#!/usr/bin/env node\n" + fixture, { mode: 0o700 })
    execFileSync("tar", ["-czf", archive, "-C", root, "fixture"])
    const bytes = await readFile(archive)
    const os = process.platform === "darwin" ? "darwin" : process.platform
    const platform = `${os}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`
    const digest = createHash("sha256").update(bytes).digest("hex")
    const dedicated = join(root, "dedicated")
    await mkdir(dedicated)
    await writeFile(
      join(dedicated, "package.json"),
      JSON.stringify({
        name: "@pigcode/agent-dedicated-fixture",
        version: "1.0.0",
        pigcode: {
          apiVersion: 1,
          kind: "agent",
          host: "./index.mjs",
          contributes: {
            agent: { id: "dedicated", acpRegistryAgentIds: ["dedicated-registry-id"] },
          },
        },
      }),
    )
    const entry = {
      id: "fixture",
      name: "Registry fixture",
      version: "1.0.0",
      description: "Fixture",
      distribution: {
        binary: {
          [platform]: {
            archive: "https://example.test/fixture.tar.gz",
            cmd: "fixture",
            sha256: digest,
            args: ["Registry Agent", "resume"],
          },
        },
      },
    }
    let downloads = 0
    const driver = new AcpDriver(async (input) => {
      if (String(input).endsWith("/registry.json"))
        return Response.json({
          agents: [entry, { ...entry, id: "dedicated-registry-id" }],
        })
      downloads += 1
      return new Response(Uint8Array.from(bytes))
    })
    const ctx = new Context()
    try {
      await ctx.plugin(storage, { path: ":memory:" })
      await ctx.plugin(settings, {})
      await ctx.plugin(projects)
      await ctx.plugin(threads)
      await ctx.plugin(sessions)
      await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
      await ctx.plugin(Loader, { baseUrl: pathToFileURL(root + "/").href })
      await ctx.plugin(plugins, { profileDir: join(root, "profile"), builtin: [dedicated] })
      ctx.agents.register(driver)
      await expect(ctx.agents.acpRegistry()).resolves.toMatchObject([
        { id: "fixture", distribution: "binary" },
      ])
      const one = ctx.agents.createInstance("acp", "Registry fixture", {
        values: { registryId: "fixture" },
      })
      const two = ctx.agents.createInstance("acp", "Other fixture", {
        values: { registryId: "fixture" },
      })
      await expect(ctx.agents.models("acp", one.instanceId)).resolves.toEqual([])
      expect(downloads).toBe(0)
      await Promise.all([
        ctx.agents.updateCli(one.instanceId),
        ctx.agents.updateCli(two.instanceId),
      ])
      await expect
        .poll(() => ctx.agents.cliUpdates())
        .toMatchObject({
          [one.instanceId]: { phase: "succeeded", currentVersion: "1.0.0" },
          [two.instanceId]: { phase: "succeeded", currentVersion: "1.0.0" },
        })
      expect(downloads).toBe(1)
      await expect(ctx.agents.models("acp", one.instanceId)).resolves.toMatchObject([
        { id: "Registry Agent" },
        { id: "Registry Agent Alternate" },
      ])
      const thread = ctx.threads.create(
        ctx.projects.add(root).id,
        "Registry test",
        "acp",
        undefined,
        { instanceId: two.instanceId },
      )
      await (
        await ctx.agents.startRun(thread.id, "hello")
      ).done
      expect(ctx.sessions.read(thread.id, 0)).toContainEqual(
        expect.objectContaining({
          type: "message.completed",
          payload: { role: "assistant", text: "Registry Agent: hello" },
        }),
      )
    } finally {
      await driver.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)

it("prepares a shared registry runtime without launching it or allocating an instance, and retries failed downloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-acp-prepare-"))
  const program = Buffer.from("A runtime fixture that cannot perform an ACP handshake")
  const platform =
    (process.platform === "win32" ? "windows" : process.platform) +
    "-" +
    (process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch)
  const digest = createHash("sha256").update(program).digest("hex")
  let downloads = 0
  const driver = new AcpDriver(async (input) => {
    if (String(input).endsWith("/registry.json"))
      return Response.json({
        agents: [
          {
            id: "amp-acp",
            name: "Amp",
            description: "A fixture",
            version: "1.2.3",
            icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/amp-acp.svg",
            website: "https://example.org",
            distribution: {
              binary: {
                [platform]: {
                  archive: "https://example.org/amp",
                  cmd: "./amp-acp",
                  sha256: digest,
                },
              },
            },
          },
        ],
      })
    downloads++
    return new Response(downloads === 1 ? "broken" : Uint8Array.from(program))
  })
  const ctx = new Context()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false, dataDir: join(root, "data") })
    ctx.agents.register(driver)
    const prepare = () => ctx.agents.prepareAcpRegistry("amp-acp")
    await expect(prepare()).rejects.toThrow(/checksum/i)
    expect(ctx.agents.listInstances("acp")).toEqual([])
    const [first, second] = await Promise.all([prepare(), prepare()])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      id: "amp-acp",
      version: "1.2.3",
      distribution: "binary",
      website: "https://example.org",
    })
    await prepare()
    expect(downloads).toBe(2)
    expect(ctx.agents.listInstances("acp")).toEqual([])
    const instance = ctx.agents.createInstance("acp", "Manual configuration", {
      values: { registryId: "amp-acp" },
    })
    const version = async () =>
      (await ctx.agents.checkCliUpdates(instance.instanceId))[instance.instanceId]?.currentVersion
    expect(await version()).toBeNull()
    await expect(ctx.agents.activateAcpRegistry("amp-acp", "unknown")).rejects.toThrow()
    await ctx.agents.activateAcpRegistry("amp-acp", first.version)
    expect(await version()).toBe(first.version)
    expect(downloads).toBe(2)
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it("sends native ACP image blocks when promptCapabilities.image is true and falls back to path text once when false", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-acp-img-test-"))
  const script = join(root, "acp-img.mjs")
  const imgFixture = String.raw`
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
const [mode] = process.argv.slice(2)
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line)
  const result = (value) => send({ id, result: value })
  if (method === "initialize") return result({
    protocolVersion: 1,
    agentInfo: { name: mode, version: "1.0.0" },
    authMethods: [],
    agentCapabilities: mode === "vision" ? { promptCapabilities: { image: true } } : {},
  })
  if (method === "session/new") return result({ sessionId: randomUUID() })
  if (method === "session/prompt") {
    send({
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(params.prompt) },
        },
      },
    })
    return result({ stopReason: "end_turn" })
  }
  send({ id, error: { code: -32601, message: "Method not found" } })
})
`
  await writeFile(script, imgFixture)
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.writeUInt32BE(13, 8)
  png.write("IHDR", 12, "ascii")
  png.writeUInt32BE(120, 16)
  png.writeUInt32BE(80, 20)

  const ctx = new Context()
  const driver = new AcpDriver()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(attachments, { attachmentsDir: join(root, "attachments") })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false, dataDir: join(root, "agent-data") })
    ctx.agents.register(driver)

    const project = ctx.projects.add(root)
    const visionInst = ctx.agents.createInstance("acp", "Vision ACP", {
      values: { binaryPath: process.execPath, arguments: [script, "vision"] },
    })
    const textOnlyInst = ctx.agents.createInstance("acp", "Text ACP", {
      values: { binaryPath: process.execPath, arguments: [script, "text-only"] },
    })

    // 1. Vision ACP: native image content block + text, NO [Attached image: ...] text fallback
    const att1 = ctx.attachments.saveStaging({ buffer: png, fileName: "chart.png" })
    const tVision = ctx.threads.create(project.id, "Vision", "acp", undefined, {
      instanceId: visionInst.instanceId,
    })
    await (
      await ctx.agents.startRun(tVision.id, "analyze", undefined, { attachmentIds: [att1.id] })
    ).done
    const visionReply = ctx.sessions
      .read(tVision.id, 0)
      .find(
        (e) =>
          e.type === "message.completed" && (e.payload as { role?: string }).role === "assistant",
      )
    const visionBlocks = JSON.parse((visionReply?.payload as { text: string }).text) as unknown[]
    expect(visionBlocks).toEqual([
      { type: "text", text: "analyze" },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ])

    // 2. Vision ACP image-only: only image block
    const att1b = ctx.attachments.saveStaging({ buffer: png, fileName: "only.png" })
    await (
      await ctx.agents.startRun(tVision.id, "", undefined, { attachmentIds: [att1b.id] })
    ).done
    const visionReply2 = ctx.sessions
      .read(tVision.id, 0)
      .filter(
        (e) =>
          e.type === "message.completed" && (e.payload as { role?: string }).role === "assistant",
      )
      .at(-1)
    expect(JSON.parse((visionReply2?.payload as { text: string }).text)).toEqual([
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ])

    // 3. Text-only ACP: falls back to [Attached image: <path> ...] ONCE (not duplicated!)
    const att2 = ctx.attachments.saveStaging({ buffer: png, fileName: "log.png" })
    const tText = ctx.threads.create(project.id, "Text", "acp", undefined, {
      instanceId: textOnlyInst.instanceId,
    })
    await (
      await ctx.agents.startRun(tText.id, "check this", undefined, { attachmentIds: [att2.id] })
    ).done
    const textReply = ctx.sessions
      .read(tText.id, 0)
      .find(
        (e) =>
          e.type === "message.completed" && (e.payload as { role?: string }).role === "assistant",
      )
    const textBlocks = JSON.parse((textReply?.payload as { text: string }).text) as Array<{
      type: string
      text?: string
    }>
    const expectedPath = ctx.attachments.getPath(att2.id, tText.id)!
    expect(textBlocks).toEqual([
      {
        type: "text",
        text: `check this\n\n[Attached image: ${expectedPath} (image/png, 120x80)]`,
      },
    ])
    // Ensure not duplicated
    expect(textBlocks[0]!.text!.split("[Attached image:").length - 1).toBe(1)
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
